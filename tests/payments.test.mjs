import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../server/app.mjs";
import { amountFen, REFUND_CONFIRMATION } from "../server/payments.mjs";
import { alipayTime, loadAlipayConfig } from "../server/alipay.mjs";
import { refundConfirmation } from "../shared/payment.mjs";

// Provider doubles exercise business state transitions, not sandbox acceptance.
async function fixture(
  t,
  { configured = true, mode = "production", trustedProxyCidrs = "" } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keyword-payments-"));
  fs.writeFileSync(
    path.join(dir, "seed.json"),
    JSON.stringify([
      {
        id: "builtin-test",
        title: "测试词库",
        words: [{ id: "one", term: "one", meaning: "一" }],
      },
    ]),
  );
  fs.writeFileSync(path.join(dir, "legacy.json"), "{}");
  const publicDir = path.join(dir, "public");
  fs.mkdirSync(publicDir);
  fs.copyFileSync(
    new URL("../index.html", import.meta.url),
    path.join(publicDir, "index.html"),
  );
  const reserve = http.createServer();
  await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  const base = `http://127.0.0.1:${port}`;
  let now = Date.now(),
    app,
    blockQuery;
  const calls = [],
    trades = new Map();
  const config = {
    mode,
    appId: "1000000000000001",
    sellerId: "2088000000000001",
  };
  const gateway = {
    config,
    payURL(row) {
      return `https://openapi-sandbox.dl.alipaydev.com/gateway.do?order=${row.out_trade_no}`;
    },
    verify(params) {
      return (
        params.sign === "valid" &&
        params.sign_type === "RSA2" &&
        params.app_id === config.appId
      );
    },
    async exec(method, data) {
      calls.push({ method, data });
      if (method === "alipay.trade.query" && blockQuery) await blockQuery;
      const trade = trades.get(data.out_trade_no);
      if (method === "alipay.trade.query")
        return trade || { code: "40004", sub_code: "ACQ.TRADE_NOT_EXIST" };
      if (method === "alipay.trade.close") {
        if (!trade || trade.trade_status !== "WAIT_BUYER_PAY")
          return { code: "40004" };
        trade.trade_status = "TRADE_CLOSED";
        return {
          code: "10000",
          out_trade_no: data.out_trade_no,
          trade_no: trade.trade_no,
        };
      }
      if (method === "alipay.trade.refund")
        return {
          code: "10000",
          out_trade_no: data.out_trade_no,
          trade_no: trade.trade_no,
          refund_fee: data.refund_amount,
          fund_change: gateway.refundFundChange ?? "Y",
        };
      if (method === "alipay.trade.fastpay.refund.query")
        return {
          code: "10000",
          out_trade_no: data.out_trade_no,
          trade_no: trade.trade_no,
          out_request_no: data.out_request_no,
          refund_amount: trade.total_amount,
          refund_status: gateway.refundStatus ?? "REFUND_SUCCESS",
        };
      throw new Error("Unsupported double method");
    },
  };
  const options = {
    dataDir: dir,
    seedFile: path.join(dir, "seed.json"),
    legacyFile: path.join(dir, "legacy.json"),
    publicDir,
    origin: base,
    secret: randomBytes(48).toString("base64url"),
    paymentGateway: configured ? gateway : null,
    paymentNow: () => now,
    trustedProxyCidrs,
  };
  async function start() {
    app = await createApp(options);
    await new Promise((r) => app.server.listen(port, "127.0.0.1", r));
  }
  await start();
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function call(
    url,
    {
      body,
      cookie = "",
      method = body === undefined ? "GET" : "POST",
      headers = {},
    } = {},
  ) {
    const response = await fetch(base + url, {
      method,
      headers: {
        Origin: base,
        Connection: "close",
        Cookie: cookie,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return {
      status: response.status,
      data,
      headers: response.headers,
      cookie: response.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; "),
    };
  }
  const f = {
    base,
    dir,
    gateway,
    calls,
    trades,
    call,
    get app() {
      return app;
    },
    advance(ms) {
      now += ms;
    },
    block(promise) {
      blockQuery = promise;
    },
    async restart() {
      await app.close();
      await new Promise(setImmediate);
      await start();
    },
    async signup(code, email = `${randomUUID()}@example.test`) {
      return call("/api/auth/sign-up/email", {
        body: {
          inviteCode: code,
          email,
          name: "Test",
          password: "a-long-test-password",
        },
      });
    },
    async admin() {
      const result = await f.signup(app.invites.create({ role: "admin" }).code);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      return result.cookie;
    },
    async stock(cookie, available = 2, enabled = true) {
      const current = await call("/api/admin/payments", { cookie });
      return call("/api/admin/payments/stock", {
        cookie,
        body: { available, enabled, version: current.data.version },
      });
    },
    async buy(extra = {}, headers = {}) {
      const proof = {
        requestId: randomUUID(),
        receipt: randomBytes(32).toString("base64url"),
        ...extra,
      };
      const result = await call("/api/purchase/orders", {
        body: proof,
        headers,
      });
      return { ...proof, ...result, id: result.data.order?.id };
    },
    order(proof) {
      return app.paymentStore.row(proof.id);
    },
    trade(proof, overrides = {}) {
      const row = f.order(proof);
      const value = {
        code: "10000",
        out_trade_no: row.out_trade_no,
        trade_no:
          trades.get(row.out_trade_no)?.trade_no ||
          "202610250000" + String(trades.size + 1).padStart(10, "0"),
        trade_status: "TRADE_SUCCESS",
        total_amount: "9.90",
        ...overrides,
      };
      trades.set(row.out_trade_no, value);
      return value;
    },
    async refresh(proof) {
      return call(`/api/purchase/orders/${proof.id}/refresh`, {
        body: {},
        headers: { "X-Keyword-Receipt": proof.receipt },
      });
    },
    async notify(proof, overrides = {}, { duplicate = false } = {}) {
      const trade = trades.get(f.order(proof).out_trade_no) || f.trade(proof);
      const params = {
        app_id: config.appId,
        seller_id: config.sellerId,
        notify_type: "trade_status_sync",
        notify_id: randomUUID(),
        sign_type: "RSA2",
        sign: "valid",
        ...trade,
        ...overrides,
      };
      delete params.code;
      const raw =
        new URLSearchParams(params).toString() +
        (duplicate ? "&app_id=other" : "");
      const response = await fetch(base + "/api/payments/alipay/notify", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Connection: "close",
        },
        body: raw,
      });
      return { status: response.status, text: await response.text(), params };
    },
  };
  return f;
}

test("Optional payments stay off without touching credentials; exact amount/time semantics", () => {
  assert.equal(
    loadAlipayConfig({ env: {}, origin: "http://127.0.0.1:3000" }),
    null,
  );
  assert.throws(
    () =>
      loadAlipayConfig({ env: { ALIPAY_MODE: "sandbox" }, production: true }),
    /禁止加载沙箱/,
  );
  assert.equal(
    alipayTime(Date.UTC(2026, 9, 25, 0, 2, 3)),
    "2026-10-25 08:02:03",
  );
  for (const [value, result] of [
    ["9.90", 990],
    ["9.9", 990],
    ["9", 900],
    ["0.01", 1],
    ["9.900", null],
    ["9e0", null],
    [9.9, null],
  ])
    assert.equal(amountFen(value), result);
});

test("Sandbox new orders are fixed at one fen, production stays 990; amount checks and full refunds use the stored amount", async (t) => {
  const f = await fixture(t, { mode: "sandbox" }),
    admin = await f.admin();
  await f.stock(admin);
  assert.equal((await f.call("/api/purchase/status")).data.amountFen, 1);
  const proof = await f.buy({ amountFen: 990, amount: "9.90" });
  assert.equal(proof.data.order.amountFen, 1);
  f.trade(proof, { total_amount: "9.90" });
  assert.equal((await f.notify(proof)).text, "fail");
  f.trade(proof, { total_amount: "0.01" });
  assert.equal((await f.refresh(proof)).data.order.state, "paid");
  const refund = await f.call(`/api/admin/payments/${proof.id}/refund`, {
    cookie: admin,
    body: { confirmation: refundConfirmation(1) },
  });
  assert.equal(refund.data.order.state, "refunded");
  assert.equal(
    f.calls.find((c) => c.method === "alipay.trade.refund").data.refund_amount,
    "0.01",
  );
});

test("Off mode preserves invitation signup and login-only library; payment setup never becomes mandatory", async (t) => {
  const f = await fixture(t, { configured: false });
  assert.equal((await f.call("/api/purchase/status")).data.configured, false);
  assert.equal((await f.buy()).status, 503);
  assert.equal((await f.call("/api/decks")).status, 401);
  const user = await f.signup(f.app.invites.create().code);
  assert.equal(user.status, 200);
  assert.equal(
    (await f.call("/api/decks", { cookie: user.cookie })).status,
    200,
  );
  assert.equal(
    (await f.call("/api/admin/payments", { cookie: user.cookie })).status,
    403,
  );
});

test("Direct and non-trusted peers cannot reset purchase limits with forged forwarding headers", async (t) => {
  for (const trustedProxyCidrs of ["", "192.0.2.1"]) {
    const f = await fixture(t, { trustedProxyCidrs }),
      admin = await f.admin();
    await f.stock(admin, 20);
    for (let i = 1; i <= 5; i++) {
      const result = await f.buy(
        {},
        {
          "X-Forwarded-For": `203.0.113.${i}`,
          "X-Real-IP": `198.51.100.${i}`,
          Forwarded: `for=192.0.2.${i}`,
          "X-Keyword-Client-IP": `192.0.2.${i}`,
        },
      );
      assert.equal(result.status, 201);
    }
    assert.equal(
      (
        await f.buy(
          {},
          { "X-Forwarded-For": "203.0.113.200", "X-Real-IP": "198.51.100.200" },
        )
      ).status,
      429,
    );
  }
});

test("Trusted NPM-style forwarding separates visitors without trusting a client's left-hand prefix", async (t) => {
  const f = await fixture(t, { trustedProxyCidrs: "127.0.0.1/32" }),
    admin = await f.admin();
  await f.stock(admin, 20);
  for (const visitor of ["203.0.113.10", "203.0.113.20"]) {
    for (let i = 1; i <= 5; i++)
      assert.equal(
        (await f.buy({}, { "X-Forwarded-For": `198.51.100.${i}, ${visitor}` }))
          .status,
        201,
      );
    assert.equal(
      (await f.buy({}, { "X-Forwarded-For": `198.51.100.200, ${visitor}` }))
        .status,
      429,
    );
  }
  assert.equal(f.app.paymentStore.stock().available, 10);
  const invalidSignup = {
    inviteCode: "invalid",
    name: "Test",
    email: "proxy@example.test",
    password: "long-test-password",
  };
  for (let i = 1; i <= 5; i++)
    assert.equal(
      (
        await f.call("/api/auth/sign-up/email", {
          body: invalidSignup,
          headers: { "X-Forwarded-For": `198.51.100.${i}, 203.0.113.10` },
        })
      ).status,
      403,
    );
  assert.equal(
    (
      await f.call("/api/auth/sign-up/email", {
        body: invalidSignup,
        headers: { "X-Forwarded-For": "198.51.100.200, 203.0.113.10" },
      })
    ).status,
    429,
  );
  assert.equal(
    (
      await f.call("/api/auth/sign-up/email", {
        body: invalidSignup,
        headers: { "X-Forwarded-For": "203.0.113.20" },
      })
    ).status,
    403,
  );
});

test("Sales default closed and finite, admin-only optimistic stock control, fixed 990 fen and scoped receipts", async (t) => {
  const f = await fixture(t),
    admin = await f.admin();
  assert.equal((await f.buy()).status, 409);
  assert.equal(
    (
      await f.call("/api/admin/payments/stock", {
        body: { enabled: true, available: 100, version: 1 },
      })
    ).status,
    401,
  );
  assert.equal((await f.stock(admin, 2)).status, 200);
  const before = (await f.call("/api/admin/payments", { cookie: admin })).data;
  const first = await f.buy({ amountFen: 1, amount: "0.01", role: "admin" });
  assert.equal(first.status, 201);
  assert.equal(first.data.order.amountFen, 990);
  assert.equal(first.data.order.code, null);
  assert.equal(f.app.paymentStore.stock().available, 1);
  const retry = await f.call("/api/purchase/orders", { body: first });
  assert.equal(retry.data.order.id, first.id);
  assert.equal(f.app.paymentStore.stock().available, 1);
  assert.equal(
    (
      await f.call("/api/purchase/orders", {
        body: {
          requestId: first.requestId,
          receipt: randomBytes(32).toString("base64url"),
        },
      })
    ).status,
    404,
  );
  const second = await f.buy();
  assert.equal((await f.buy()).status, 409);
  for (const receipt of [
    undefined,
    second.receipt,
    first.receipt.slice(1),
    "a".repeat(43),
  ]) {
    assert.equal(
      (
        await f.call(`/api/purchase/orders/${first.id}`, {
          headers: receipt ? { "X-Keyword-Receipt": receipt } : {},
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await f.call(`/api/purchase/orders/${first.id}/pay`, {
          body: {},
          headers: receipt ? { "X-Keyword-Receipt": receipt } : {},
        })
      ).status,
      404,
    );
  }
  const stale = await f.call("/api/admin/payments/stock", {
    cookie: admin,
    body: { version: before.version, enabled: true, available: 100 },
  });
  assert.equal(stale.status, 409);
  const raw = f.app.db
    .prepare("SELECT * FROM payment_orders WHERE id=?")
    .get(first.id);
  assert.ok(!JSON.stringify(raw).includes(first.receipt));
  assert.ok(
    !JSON.stringify((await f.call("/api/purchase/status")).data).includes(
      first.id,
    ),
  );
  assert.equal(
    (await f.call(`/api/purchase/orders/${first.id}?receipt=${first.receipt}`))
      .status,
    404,
  );
  assert.equal(
    (
      await f.call(`/api/purchase/orders/${first.id}/pay`, {
        body: {},
        headers: {
          Origin: "https://attacker.test",
          "X-Keyword-Receipt": first.receipt,
        },
      })
    ).status,
    403,
  );
});

test("Only signed, matched payment events issue one permanent ordinary invitation; restart and single-use survive", async (t) => {
  const f = await fixture(t),
    admin = await f.admin();
  await f.stock(admin);
  const proof = await f.buy();
  f.trade(proof);
  for (const mutation of [
    { sign: "bad" },
    { sign_type: "RSA" },
    { app_id: "other" },
    { seller_id: "other" },
    { total_amount: "0.01" },
    { out_trade_no: "unknown" },
    { notify_type: "other" },
    { notify_id: "" },
  ])
    assert.equal((await f.notify(proof, mutation)).text, "fail");
  assert.equal((await f.notify(proof, {}, { duplicate: true })).text, "fail");
  for (const mutation of [
    { out_biz_no: "refund-1" },
    { gmt_refund: "2026-10-25 12:00:00" },
    { refund_fee: "9.90" },
    { trade_status: "WAIT_BUYER_PAY" },
  ])
    assert.equal((await f.notify(proof, mutation)).text, "success");
  assert.equal(f.order(proof).state, "pending");
  const sent = await f.notify(proof);
  assert.equal(sent.text, "success");
  assert.equal((await f.notify(proof, sent.params)).text, "success");
  const code = (await f.refresh(proof)).data.order.code;
  assert.match(code, /^KW-/);
  assert.equal(
    f.app.db
      .prepare(
        "SELECT count(*) n FROM signup_invitations WHERE validity='permanent'",
      )
      .get().n,
    1,
  );
  const invite = f.app.invites
    .list()
    .find((row) => row.validity === "permanent");
  assert.equal(invite.role, "user");
  assert.equal(invite.expiresAt, null);
  await f.restart();
  f.advance(10 * 365 * 86400000);
  assert.equal((await f.refresh(proof)).data.order.code, code);
  const result = await f.signup(code);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.user.role, "user");
  assert.equal((await f.signup(code)).status, 403);
  const used = (await f.refresh(proof)).data.order;
  assert.equal(used.code, null);
  assert.equal(used.invitationUsed, true);
  const listed = (await f.call("/api/admin/payments", { cookie: admin })).data;
  assert.ok(!JSON.stringify(listed.orders).includes(code));
});

test("Query compensates missing webhook; failed/unknown/waiting provider results never become payment success", async (t) => {
  const f = await fixture(t),
    admin = await f.admin();
  await f.stock(admin, 5);
  const proof = await f.buy();
  assert.equal((await f.refresh(proof)).data.order.state, "pending");
  for (const trade_status of ["WAIT_BUYER_PAY", "UNKNOWN"]) {
    f.advance(4000);
    f.trade(proof, { trade_status });
    assert.equal((await f.refresh(proof)).data.order.state, "pending");
  }
  f.advance(4000);
  f.trade(proof, { total_amount: "0.01" });
  assert.equal((await f.refresh(proof)).data.order.code, null);
  f.advance(4000);
  f.trade(proof);
  assert.equal((await f.refresh(proof)).data.order.state, "paid");
  assert.equal(f.app.paymentStore.stock().sold, 1);
  assert.ok(f.calls.every((call) => call.method !== "alipay.trade.page.pay"));
});

test("Issuance plus payment/event recording commit atomically and retry after failure", async (t) => {
  const f = await fixture(t),
    admin = await f.admin();
  await f.stock(admin);
  const proof = await f.buy();
  f.trade(proof);
  f.app.db.exec(
    "CREATE TRIGGER payment_fail BEFORE UPDATE OF state ON payment_orders WHEN NEW.state='paid' BEGIN SELECT RAISE(ABORT,'injected'); END",
  );
  const event = await f.notify(proof);
  assert.equal(event.text, "fail");
  assert.equal(f.order(proof).state, "pending");
  assert.equal(
    f.app.db
      .prepare(
        "SELECT count(*) n FROM signup_invitations WHERE validity='permanent'",
      )
      .get().n,
    0,
  );
  assert.equal(
    f.app.db.prepare("SELECT count(*) n FROM payment_notifications").get().n,
    0,
  );
  f.app.db.exec("DROP TRIGGER payment_fail");
  assert.equal((await f.notify(proof, event.params)).text, "success");
  assert.equal((await f.refresh(proof)).data.order.state, "paid");
});

test("Unopened pay links keep stock until expiry, while confirmed close releases exactly once", async (t) => {
  const f = await fixture(t),
    admin = await f.admin();
  await f.stock(admin, 2);
  const unopened = await f.buy();
  const close = (p) =>
    f.call(`/api/purchase/orders/${p.id}/close`, {
      body: {},
      headers: { "X-Keyword-Receipt": p.receipt },
    });
  assert.equal((await close(unopened)).data.order.state, "closing");
  assert.equal(f.app.paymentStore.stock().available, 1);
  assert.equal(
    (
      await f.call(`/api/purchase/orders/${unopened.id}/pay`, {
        body: {},
        headers: { "X-Keyword-Receipt": unopened.receipt },
      })
    ).status,
    409,
  );
  const waiting = await f.buy();
  f.trade(waiting, { trade_status: "WAIT_BUYER_PAY" });
  assert.equal((await close(waiting)).data.order.state, "closed");
  assert.equal((await close(waiting)).data.order.state, "closed");
  assert.equal(f.app.paymentStore.stock().available, 1);
  f.advance(32 * 60000);
  await f.app.payments.reconcile();
  assert.equal(f.order(unopened).state, "closed");
  assert.equal(f.app.paymentStore.stock().available, 2);
  assert.equal(
    (await f.notify(waiting, { trade_status: "TRADE_SUCCESS" })).text,
    "fail",
  );
});

test("Full refund suspends signup, persists one request across unknown results and revokes/replenishes only once", async (t) => {
  const f = await fixture(t),
    admin = await f.admin();
  await f.stock(admin);
  const proof = await f.buy();
  f.trade(proof);
  const code = (await f.refresh(proof)).data.order.code;
  const endpoint = `/api/admin/payments/${proof.id}/refund`;
  assert.equal(
    (await f.call(endpoint, { cookie: admin, body: {} })).status,
    400,
  );
  f.gateway.refundFundChange = "N";
  assert.equal(
    (
      await f.call(endpoint, {
        cookie: admin,
        body: { confirmation: REFUND_CONFIRMATION },
      })
    ).data.order.state,
    "refund_pending",
  );
  assert.equal((await f.signup(code)).status, 403);
  assert.equal((await f.refresh(proof)).data.order.code, null);
  assert.equal(
    (
      await f.call(`/api/admin/payments/${proof.id}/refund-query`, {
        cookie: admin,
        body: {},
      })
    ).status,
    429,
  );
  await f.restart();
  await f.call(endpoint, {
    cookie: admin,
    body: { confirmation: REFUND_CONFIRMATION },
  });
  const refunds = f.calls.filter(
    (call) => call.method === "alipay.trade.refund",
  );
  assert.equal(refunds.length, 2);
  assert.deepEqual(refunds[0].data, refunds[1].data);
  f.advance(11000);
  assert.equal(
    (
      await f.call(`/api/admin/payments/${proof.id}/refund-query`, {
        cookie: admin,
        body: {},
      })
    ).data.order.state,
    "refunded",
  );
  assert.equal(
    (
      await f.call(endpoint, {
        cookie: admin,
        body: { confirmation: REFUND_CONFIRMATION },
      })
    ).data.order.state,
    "refunded",
  );
  assert.equal(f.app.paymentStore.stock().available, 2);
  assert.equal((await f.notify(proof)).text, "success");
  assert.equal((await f.refresh(proof)).data.order.state, "refunded");
  assert.equal((await f.signup(code)).status, 403);
});

test("Used paid invitations cannot be refunded; payment service never holds the DB gate during remote I/O", async (t) => {
  const f = await fixture(t),
    admin = await f.admin();
  await f.stock(admin);
  const proof = await f.buy();
  f.trade(proof);
  const code = (await f.refresh(proof)).data.order.code;
  await f.signup(code);
  assert.equal(
    (
      await f.call(`/api/admin/payments/${proof.id}/refund`, {
        cookie: admin,
        body: { confirmation: REFUND_CONFIRMATION },
      })
    ).status,
    409,
  );
  f.advance(4000);
  let release, entered;
  f.block(
    new Promise((r) => {
      release = r;
    }),
  );
  const reached = new Promise((r) => {
    entered = r;
  });
  const original = f.gateway.exec;
  f.gateway.exec = (...args) => {
    entered();
    return original(...args);
  };
  const remote = f.refresh(proof);
  await reached;
  try {
    const me = await Promise.race([
      f.call("/api/me", { cookie: admin }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("DB gate held during remote I/O")),
          1500,
        ),
      ),
    ]);
    assert.equal(me.status, 200);
    assert.equal(me.data.user.role, "admin");
  } finally {
    release();
    await remote;
  }
});

test("Payment SQLite transitions wait for Better Auth's cross-await signup transaction", async (t) => {
  const f = await fixture(t),
    admin = await f.admin();
  await f.stock(admin);
  const proof = await f.buy();
  f.trade(proof);
  const context = await f.app.auth.$context,
    original = context.password.hash;
  let release, entered;
  const paused = new Promise((r) => {
      entered = r;
    }),
    resume = new Promise((r) => {
      release = r;
    });
  context.password.hash = async (...args) => {
    entered();
    await resume;
    return original(...args);
  };
  const signing = f.signup(f.app.invites.create().code);
  await paused;
  const notified = f.notify(proof);
  release();
  assert.equal((await signing).status, 200);
  assert.equal((await notified).text, "success");
  assert.equal((await f.refresh(proof)).data.order.state, "paid");
});

test("Return shell exists with neutral unauthenticated state and repository/config paths stay private", async (t) => {
  const f = await fixture(t);
  const page = await f.call(
    "/payment/return?out_trade_no=forged&trade_status=TRADE_SUCCESS",
  );
  assert.equal(page.status, 200);
  assert.match(page.data, /purchaseDialog/);
  assert.match(
    page.headers.get("content-security-policy"),
    /form-action 'self'/,
  );
  assert.ok(
    !page.headers
      .get("content-security-policy")
      .includes("script-src 'self' 'unsafe-inline'"),
  );
  for (const file of [
    "/.alipay-sandbox.json",
    "/server/payments.mjs",
    "/.env",
    "/data/keyword.sqlite",
  ])
    assert.equal((await f.call(file)).status, 404);
  assert.equal((await f.call("/api/decks")).status, 401);
});
