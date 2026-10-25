import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { InputError } from "../shared/words.mjs";
import {
  INVITE_PRICE_FEN,
  SANDBOX_PRICE_FEN,
  paymentPriceFen,
  yuan,
  refundConfirmation,
} from "../shared/payment.mjs";

export { INVITE_PRICE_FEN };
export const REFUND_CONFIRMATION = refundConfirmation(INVITE_PRICE_FEN);
const TTL = 30 * 60 * 1000;
const PAID = new Set(["TRADE_SUCCESS", "TRADE_FINISHED"]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const notFound = () => new InputError("订单不存在或领取凭据不匹配", 404);
function receiptHash(receipt) {
  if (typeof receipt !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(receipt))
    throw notFound();
  return hash(receipt);
}
export function amountFen(value) {
  if (typeof value !== "string" || !/^\d{1,11}(?:\.\d{1,2})?$/.test(value))
    return null;
  const [whole, fraction = ""] = value.split(".");
  return Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0")));
}
function providerError() {
  return new InputError(
    "支付宝暂未确认结果，请保留订单并稍后查询，不要重复付款",
    502,
  );
}

export class PaymentStore {
  constructor(db, invites, { config, secret, now = Date.now } = {}) {
    this.db = db;
    this.invites = invites;
    this.config = config;
    this.now = now;
    this.secret = secret;
    this.scope = config ? `${config.mode}:${config.appId}` : "off";
    db.exec(`
      CREATE TABLE IF NOT EXISTS payment_inventory (
        scope TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
        available INTEGER NOT NULL DEFAULT 0 CHECK(available>=0),
        version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, updated_by TEXT
      );
      CREATE TABLE IF NOT EXISTS payment_orders (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, request_id TEXT NOT NULL,
        receipt_hash TEXT NOT NULL, out_trade_no TEXT NOT NULL UNIQUE,
        amount_fen INTEGER NOT NULL CHECK(amount_fen IN (1,990)), state TEXT NOT NULL,
        trade_no TEXT UNIQUE, invite_id TEXT UNIQUE REFERENCES signup_invitations(id),
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, paid_at INTEGER,
        closed_at INTEGER, last_query_at INTEGER, ip_hash TEXT NOT NULL,
        refund_id TEXT UNIQUE, refund_requested_at INTEGER, refund_checked_at INTEGER,
        refunded_at INTEGER, last_error TEXT, UNIQUE(scope,request_id)
      );
      CREATE INDEX IF NOT EXISTS payment_orders_pending ON payment_orders(scope,state,expires_at);
      CREATE TABLE IF NOT EXISTS payment_notifications (
        scope TEXT NOT NULL, notify_id TEXT NOT NULL, out_trade_no TEXT NOT NULL,
        trade_no TEXT NOT NULL, event TEXT NOT NULL, received_at INTEGER NOT NULL,
        PRIMARY KEY(scope,notify_id)
      );
      CREATE TABLE IF NOT EXISTS payment_admin_actions (
        id INTEGER PRIMARY KEY, order_id TEXT, action TEXT NOT NULL,
        actor TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    const orderSchema = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='payment_orders'",
      )
      .get().sql;
    if (/CHECK\s*\(\s*amount_fen\s*=\s*990\s*\)/i.test(orderSchema)) {
      // Keep existing order numbers, receipts and settled amounts unchanged.
      this.transaction(() => {
        db.exec(
          orderSchema
            .replace("payment_orders", "payment_orders_rebuild")
            .replace(
              /CHECK\s*\(\s*amount_fen\s*=\s*990\s*\)/i,
              "CHECK(amount_fen IN (1,990))",
            ),
        );
        db.exec(
          "INSERT INTO payment_orders_rebuild SELECT * FROM payment_orders; DROP TABLE payment_orders; ALTER TABLE payment_orders_rebuild RENAME TO payment_orders;",
        );
      });
      db.exec(
        "CREATE INDEX IF NOT EXISTS payment_orders_pending ON payment_orders(scope,state,expires_at)",
      );
    }
    db.prepare(
      "INSERT OR IGNORE INTO payment_inventory(scope,updated_at) VALUES(?,?)",
    ).run(this.scope, now());
  }
  transaction(action) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  stock() {
    const row = this.db
      .prepare("SELECT * FROM payment_inventory WHERE scope=?")
      .get(this.scope);
    const counts = this.db
      .prepare(
        `SELECT
      sum(CASE WHEN state IN ('pending','closing') THEN 1 ELSE 0 END) reserved,
      sum(CASE WHEN paid_at IS NOT NULL AND refunded_at IS NULL THEN 1 ELSE 0 END) sold
      FROM payment_orders WHERE scope=?`,
      )
      .get(this.scope);
    return {
      enabled: Boolean(row.enabled),
      available: row.available,
      version: row.version,
      reserved: counts.reserved || 0,
      sold: counts.sold || 0,
    };
  }
  setStock(body, actor) {
    if (!this.config) throw new InputError("支付未配置，不能开放销售", 409);
    if (
      typeof body.enabled !== "boolean" ||
      !Number.isInteger(body.available) ||
      body.available < 0 ||
      body.available > 100000
    )
      throw new InputError("可售余量必须为 0–100000 的整数，并指定销售开关");
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE payment_inventory SET enabled=?,available=?,
      version=version+1,updated_at=?,updated_by=? WHERE scope=? AND version=?`,
        )
        .run(
          Number(body.enabled),
          body.available,
          this.now(),
          actor,
          this.scope,
          body.version,
        );
      if (!result.changes)
        throw new InputError("销售余量已变化，请刷新后再保存", 409);
      this.audit(null, "stock", actor);
      return this.stock();
    });
  }
  audit(id, action, actor) {
    this.db
      .prepare(
        "INSERT INTO payment_admin_actions(order_id,action,actor,created_at) VALUES(?,?,?,?)",
      )
      .run(id, action, actor, this.now());
  }
  row(id) {
    return this.db
      .prepare("SELECT * FROM payment_orders WHERE id=? AND scope=?")
      .get(id, this.scope);
  }
  authorized(id, receipt) {
    const digest = receiptHash(receipt),
      row = this.row(id);
    if (
      !row ||
      !timingSafeEqual(Buffer.from(digest), Buffer.from(row.receipt_hash))
    )
      throw notFound();
    return row;
  }
  create(body, ip) {
    if (!this.config)
      throw new InputError("暂未开通在线购买，请联系管理员获取邀请码", 503);
    if (
      typeof body.requestId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(body.requestId)
    )
      throw new InputError("购买请求标识无效");
    const receipt = receiptHash(body.receipt);
    return this.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM payment_orders WHERE scope=? AND request_id=?")
        .get(this.scope, body.requestId);
      if (existing) return this.authorized(existing.id, body.receipt);
      const stock = this.stock();
      if (!stock.enabled || !stock.available)
        throw new InputError(
          stock.enabled
            ? "本批邀请码已售罄，请稍后再来"
            : "在线销售暂未开放，请联系管理员",
          409,
        );
      const ipHash = createHmac("sha256", this.secret).update(ip).digest("hex");
      const recent = this.db
        .prepare(
          `SELECT count(*) AS n FROM payment_orders
        WHERE scope=? AND ip_hash=? AND created_at>?`,
        )
        .get(this.scope, ipHash, this.now() - 3600000).n;
      if (recent >= 5)
        throw new InputError("购买请求过于频繁，请使用已有订单或稍后重试", 429);
      const id = randomUUID(),
        now = this.now(),
        outTradeNo = "KW" + randomBytes(20).toString("hex");
      this.db
        .prepare(
          `INSERT INTO payment_orders(id,scope,request_id,receipt_hash,out_trade_no,
        amount_fen,state,created_at,expires_at,ip_hash) VALUES(?,?,?,?,?,?,'pending',?,?,?)`,
        )
        .run(
          id,
          this.scope,
          body.requestId,
          receipt,
          outTradeNo,
          paymentPriceFen(this.config.mode),
          now,
          now + TTL,
          ipHash,
        );
      this.db
        .prepare(
          "UPDATE payment_inventory SET available=available-1,version=version+1 WHERE scope=?",
        )
        .run(this.scope);
      return this.row(id);
    });
  }
  view(row, { admin = false } = {}) {
    const invite = row.invite_id
      ? this.db
          .prepare("SELECT * FROM signup_invitations WHERE id=?")
          .get(row.invite_id)
      : null;
    const result = {
      id: row.id,
      number: row.out_trade_no,
      state: row.state,
      amountFen: row.amount_fen,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      paidAt: row.paid_at,
      refundedAt: row.refunded_at,
      refundRequestedAt: row.refund_requested_at,
      lastError: row.last_error || "",
      invitationUsed: Boolean(invite?.used_at),
      invitationRevoked: Boolean(invite?.revoked_at),
      code: null,
    };
    if (
      !admin &&
      row.state === "paid" &&
      invite &&
      !invite.used_at &&
      !invite.revoked_at &&
      !invite.suspended_at
    ) {
      try {
        if (!invite.code_encrypted) throw new Error();
        result.code = this.invites.decrypt(invite.code_encrypted, invite.id);
      } catch {
        result.lastError = "邀请码无法解密，请向管理员提供订单号；不要重复购买";
      }
    }
    return result;
  }
  list() {
    return this.db
      .prepare(
        "SELECT * FROM payment_orders WHERE scope=? ORDER BY created_at DESC,id LIMIT 100",
      )
      .all(this.scope)
      .map((row) => this.view(row, { admin: true }));
  }
  validateTrade(row, data, { notify = false } = {}) {
    if (
      !row ||
      row.scope !== this.scope ||
      data.out_trade_no !== row.out_trade_no ||
      amountFen(data.total_amount) !== row.amount_fen ||
      !/^\d{8,64}$/.test(data.trade_no || "") ||
      (row.trade_no && row.trade_no !== data.trade_no)
    )
      throw new InputError("支付宝订单校验未通过", 400);
    if (
      notify &&
      (data.app_id !== this.config.appId ||
        data.seller_id !== this.config.sellerId)
    )
      throw new InputError("支付宝收款方校验未通过", 400);
    if (data.seller_id && data.seller_id !== this.config.sellerId)
      throw new InputError("支付宝收款方校验未通过", 400);
  }
  paid(row, data) {
    this.validateTrade(row, data);
    if (row.paid_at !== null) return this.row(row.id);
    // A confirmed closed order cannot become paid from a late, older event.
    if (row.state === "closed")
      throw new InputError("已关闭订单收到付款事件，需要管理员核对", 409);
    const invitation = this.invites.createPaid(row.id);
    this.db
      .prepare(
        `UPDATE payment_orders SET state='paid',trade_no=?,invite_id=?,paid_at=?,last_error=NULL WHERE id=?`,
      )
      .run(data.trade_no, invitation.id, this.now(), row.id);
    return this.row(row.id);
  }
  applyQuery(id, data) {
    return this.transaction(() => {
      const row = this.row(id);
      this.validateTrade(row, data);
      this.db
        .prepare(
          "UPDATE payment_orders SET trade_no=COALESCE(trade_no,?),last_error=NULL WHERE id=?",
        )
        .run(data.trade_no, id);
      if (PAID.has(data.trade_status)) {
        // Querying a refunded trade can still report TRADE_SUCCESS. It must not
        // clear a refund hold, reissue a code or restore a revoked invitation.
        return this.paid(this.row(id), data);
      }
      if (data.trade_status === "TRADE_CLOSED" && row.paid_at === null)
        return this.close(row);
      return row;
    });
  }
  notification(params) {
    return this.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT * FROM payment_orders WHERE scope=? AND out_trade_no=?",
        )
        .get(this.scope, params.out_trade_no);
      this.validateTrade(row, params, { notify: true });
      const nonPayment = Boolean(
        params.out_biz_no || params.gmt_refund || params.refund_fee,
      );
      const event = nonPayment
        ? "non-payment:" + params.trade_status
        : params.trade_status;
      const prior = this.db
        .prepare(
          "SELECT * FROM payment_notifications WHERE scope=? AND notify_id=?",
        )
        .get(this.scope, params.notify_id);
      if (prior) {
        if (
          prior.out_trade_no !== row.out_trade_no ||
          prior.trade_no !== params.trade_no ||
          prior.event !== event
        )
          throw new InputError("支付宝通知标识冲突");
        return;
      }
      this.db
        .prepare(
          "UPDATE payment_orders SET trade_no=COALESCE(trade_no,?) WHERE id=?",
        )
        .run(params.trade_no, row.id);
      if (!nonPayment && PAID.has(params.trade_status)) this.paid(row, params);
      else if (
        !nonPayment &&
        params.trade_status === "TRADE_CLOSED" &&
        row.paid_at === null
      )
        this.close(row);
      this.db
        .prepare("INSERT INTO payment_notifications VALUES(?,?,?,?,?,?)")
        .run(
          this.scope,
          params.notify_id,
          row.out_trade_no,
          params.trade_no,
          event,
          this.now(),
        );
    });
  }
  close(row) {
    if (!row || row.paid_at !== null || row.state === "closed") return row;
    this.db
      .prepare(
        "UPDATE payment_orders SET state='closed',closed_at=?,last_error=NULL WHERE id=?",
      )
      .run(this.now(), row.id);
    this.db
      .prepare(
        "UPDATE payment_inventory SET available=available+1,version=version+1 WHERE scope=?",
      )
      .run(this.scope);
    return this.row(row.id);
  }
  queryStart(id, { force = false } = {}) {
    const row = this.row(id);
    if (!row) throw notFound();
    if (
      !force &&
      row.last_query_at !== null &&
      this.now() - row.last_query_at < 3000
    )
      return null;
    this.db
      .prepare("UPDATE payment_orders SET last_query_at=? WHERE id=?")
      .run(this.now(), id);
    return row;
  }
  note(id, text) {
    this.db
      .prepare("UPDATE payment_orders SET last_error=? WHERE id=? AND scope=?")
      .run(text, id, this.scope);
  }
  refundStart(id, actor) {
    return this.transaction(() => {
      const row = this.row(id);
      if (!row) throw notFound();
      if (row.state === "refunded") return row;
      if (
        !["paid", "refund_pending"].includes(row.state) ||
        ![INVITE_PRICE_FEN, SANDBOX_PRICE_FEN].includes(row.amount_fen)
      )
        throw new InputError("仅可全额退还已付款订单", 409);
      const invite = this.db
        .prepare("SELECT used_at FROM signup_invitations WHERE id=?")
        .get(row.invite_id);
      if (!invite || invite.used_at !== null)
        throw new InputError("邀请码已注册使用，不能直接退款", 409);
      this.db
        .prepare(
          "UPDATE signup_invitations SET suspended_at=COALESCE(suspended_at,?) WHERE id=?",
        )
        .run(this.now(), row.invite_id);
      this.db
        .prepare(
          `UPDATE payment_orders SET state='refund_pending',refund_id=COALESCE(refund_id,?),
        refund_requested_at=COALESCE(refund_requested_at,?),last_error=NULL WHERE id=?`,
        )
        .run("KWR" + randomBytes(18).toString("hex"), this.now(), id);
      this.audit(id, "refund-request", actor);
      return this.row(id);
    });
  }
  refundComplete(id, data, { queried = false } = {}) {
    return this.transaction(() => {
      const row = this.row(id);
      if (row.state === "refunded") return row;
      if (
        row.state !== "refund_pending" ||
        data.out_trade_no !== row.out_trade_no ||
        data.trade_no !== row.trade_no ||
        amountFen(queried ? data.refund_amount : data.refund_fee) !==
          row.amount_fen ||
        (queried && data.out_request_no !== row.refund_id) ||
        (queried
          ? data.refund_status !== "REFUND_SUCCESS"
          : data.fund_change !== "Y")
      )
        throw new InputError("退款结果尚未确认，请稍后查询", 409);
      this.db
        .prepare(
          "UPDATE signup_invitations SET revoked_at=COALESCE(revoked_at,?),code_encrypted=NULL WHERE id=? AND used_at IS NULL",
        )
        .run(this.now(), row.invite_id);
      this.db
        .prepare(
          "UPDATE payment_orders SET state='refunded',refunded_at=?,last_error=NULL WHERE id=?",
        )
        .run(this.now(), id);
      this.db
        .prepare(
          "UPDATE payment_inventory SET available=available+1,version=version+1 WHERE scope=?",
        )
        .run(this.scope);
      return this.row(id);
    });
  }
}

// Every SQLite step uses the same gate as Better Auth. A provider round-trip is
// deliberately outside it, including webhook verification and compensation.
export class PaymentService {
  constructor(store, gateway, gate) {
    this.store = store;
    this.gateway = gateway;
    this.gate = gate;
    this.inflight = new Map();
  }
  configured() {
    if (!this.gateway)
      throw new InputError("暂未开通在线购买，请联系管理员", 503);
  }
  async create(body, ip) {
    this.configured();
    const row = await this.gate(() => this.store.create(body, ip));
    return this.gate(() => this.store.view(this.store.row(row.id)));
  }
  async read(id, receipt) {
    return this.gate(() => this.store.view(this.store.authorized(id, receipt)));
  }
  async pay(id, receipt) {
    this.configured();
    const row = await this.gate(() => this.store.authorized(id, receipt));
    if (
      row.state !== "pending" ||
      row.amount_fen !== paymentPriceFen(this.gateway.config.mode) ||
      row.expires_at - this.store.now() < 60000
    )
      throw new InputError("此订单不能继续付款，请先查询订单状态", 409);
    try {
      return this.gateway.payURL(row);
    } catch {
      throw new InputError("支付链接未生成，请联系管理员检查支付配置", 503);
    }
  }
  async refresh(id, receipt, { admin = false } = {}) {
    this.configured();
    await this.gate(() => {
      const row = admin
        ? this.store.row(id)
        : this.store.authorized(id, receipt);
      if (!row) throw notFound();
    });
    if (!this.inflight.has(id)) {
      const task = this.query(id).finally(() => this.inflight.delete(id));
      this.inflight.set(id, task);
    }
    await this.inflight.get(id);
    return this.gate(() => this.store.view(this.store.row(id), { admin }));
  }
  async query(id) {
    const row = await this.gate(() => this.store.queryStart(id));
    if (!row || ["closed", "refunded"].includes(row.state)) return;
    try {
      const result = await this.gateway.exec("alipay.trade.query", {
        out_trade_no: row.out_trade_no,
      });
      if (result.code === "10000") {
        await this.gate(() => this.store.applyQuery(id, result));
        if (
          result.trade_status === "WAIT_BUYER_PAY" &&
          (row.state === "closing" || row.expires_at < this.store.now())
        )
          await this.closeRemote(id);
      } else if (result.sub_code === "ACQ.TRADE_NOT_EXIST") {
        // A previously issued payment link remains usable until time_expire.
        // Do not release its stock just because the QR has not been opened yet.
        if (this.store.now() > row.expires_at + 60000)
          await this.gate(() =>
            this.store.transaction(() => this.store.close(this.store.row(id))),
          );
      } else throw providerError();
    } catch {
      await this.gate(() =>
        this.store.note(id, "支付宝暂未确认结果，请稍后查询；不要重复付款"),
      );
    }
  }
  async close(id, receipt, { admin = false, actor = null } = {}) {
    this.configured();
    await this.gate(() => {
      const row = admin
        ? this.store.row(id)
        : this.store.authorized(id, receipt);
      if (!row) throw notFound();
      if (!["pending", "closing", "closed"].includes(row.state))
        throw new InputError("已付款订单不能关单", 409);
      if (row.state !== "closed")
        this.store.db
          .prepare(
            "UPDATE payment_orders SET state='closing',last_query_at=NULL WHERE id=?",
          )
          .run(id);
      if (actor) this.store.audit(id, "close-request", actor);
    });
    return this.refresh(id, receipt, { admin });
  }
  async closeRemote(id) {
    const row = await this.gate(() => this.store.row(id));
    if (!row || row.paid_at !== null || row.state === "closed") return;
    const result = await this.gateway.exec("alipay.trade.close", {
      out_trade_no: row.out_trade_no,
    });
    if (
      result.code !== "10000" ||
      result.out_trade_no !== row.out_trade_no ||
      !result.trade_no ||
      (row.trade_no && row.trade_no !== result.trade_no)
    )
      throw providerError();
    await this.gate(() =>
      this.store.transaction(() => this.store.close(this.store.row(id))),
    );
  }
  async notify(params) {
    this.configured();
    if (
      params.notify_type !== "trade_status_sync" ||
      !/^[\w-]{1,200}$/.test(params.notify_id || "") ||
      ![...PAID, "WAIT_BUYER_PAY", "TRADE_CLOSED"].includes(
        params.trade_status,
      ) ||
      !this.gateway.verify(params)
    )
      throw new InputError("支付宝通知验签未通过");
    await this.gate(() => this.store.notification(params));
  }
  async refund(id, actor, confirmation) {
    this.configured();
    const row = await this.gate(() => {
      const current = this.store.row(id);
      if (!current) throw notFound();
      if (confirmation !== refundConfirmation(current.amount_fen))
        throw new InputError("退款需明确确认全额及撤销邀请码");
      return this.store.refundStart(id, actor);
    });
    if (row.state !== "refunded") {
      try {
        const result = await this.gateway.exec("alipay.trade.refund", {
          out_trade_no: row.out_trade_no,
          refund_amount: yuan(row.amount_fen),
          out_request_no: row.refund_id,
          refund_reason: "退还未使用的注册邀请码",
        });
        if (result.code === "10000" && result.fund_change === "Y")
          await this.gate(() => this.store.refundComplete(id, result));
        else throw providerError();
      } catch {
        await this.gate(() =>
          this.store.note(
            id,
            "退款尚未确认，邀请码暂停使用；10秒后查询或使用原请求重试",
          ),
        );
      }
    }
    return this.gate(() =>
      this.store.view(this.store.row(id), { admin: true }),
    );
  }
  async refundQuery(id, actor) {
    this.configured();
    const row = await this.gate(() => {
      const current = this.store.row(id);
      if (!current?.refund_id) throw new InputError("此订单尚无退款请求", 409);
      if (
        this.store.now() -
          Math.max(
            current.refund_requested_at,
            current.refund_checked_at || 0,
          ) <
        10000
      )
        throw new InputError("请至少间隔10秒再查询退款", 429);
      this.store.db
        .prepare("UPDATE payment_orders SET refund_checked_at=? WHERE id=?")
        .run(this.store.now(), id);
      this.store.audit(id, "refund-query", actor);
      return current;
    });
    if (row.state !== "refunded") {
      try {
        const result = await this.gateway.exec(
          "alipay.trade.fastpay.refund.query",
          {
            out_trade_no: row.out_trade_no,
            out_request_no: row.refund_id,
          },
        );
        if (
          result.code === "10000" &&
          result.refund_status === "REFUND_SUCCESS"
        )
          await this.gate(() =>
            this.store.refundComplete(id, result, { queried: true }),
          );
        else throw providerError();
      } catch {
        await this.gate(() =>
          this.store.note(
            id,
            "退款尚未确认，保留原退款请求与暂停状态，请稍后重试",
          ),
        );
      }
    }
    return this.gate(() =>
      this.store.view(this.store.row(id), { admin: true }),
    );
  }
  async reconcile() {
    if (!this.gateway || this.reconciling) return;
    this.reconciling = (async () => {
      const rows = await this.gate(() =>
        this.store.db
          .prepare(
            `SELECT id FROM payment_orders
        WHERE scope=? AND state IN ('pending','closing') AND expires_at<? ORDER BY expires_at LIMIT 20`,
          )
          .all(this.store.scope, this.store.now()),
      );
      for (const row of rows) await this.refresh(row.id, null, { admin: true });
    })();
    try {
      await this.reconciling;
    } finally {
      this.reconciling = null;
    }
  }
  start() {
    if (!this.gateway) return;
    this.timer = setInterval(() => {
      this.reconcile().catch(() => {});
    }, 60000);
    this.timer.unref();
  }
  async stop() {
    clearInterval(this.timer);
    await this.reconciling;
    await Promise.allSettled([...this.inflight.values()]);
  }
}
