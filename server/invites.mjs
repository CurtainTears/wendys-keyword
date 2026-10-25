import {
  createHash,
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
} from "node:crypto";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { InputError } from "../shared/words.mjs";

const DAY = 86400000;
function fingerprint(code) {
  if (typeof code !== "string" || code.length > 128) return null;
  const normalized = code.toUpperCase().replace(/[\s-]/g, "");
  if (!/^KW[A-F0-9]{40}$/.test(normalized)) return null;
  return createHash("sha256").update(normalized).digest("hex");
}
function denied(missing = false) {
  return new APIError("FORBIDDEN", {
    code: missing ? "INVITE_REQUIRED" : "INVITE_INVALID",
    message: missing
      ? "注册需要邀请码，请联系管理员获取。"
      : "邀请码无效、已使用或已失效，请联系管理员。",
  });
}
export class InvitationStore {
  constructor(db, { now = Date.now, secret } = {}) {
    this.db = db;
    this.now = now;
    this.key = secret
      ? Buffer.from(
          hkdfSync("sha256", secret, "keyword", "invitation-display-v1", 32),
        )
      : null;
    db.exec(`CREATE TABLE IF NOT EXISTS signup_invitations (
      id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      used_at INTEGER, used_email TEXT, revoked_at INTEGER
    );`);
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(signup_invitations)")
        .all()
        .map((r) => r.name),
    );
    for (const [column, definition] of [
      ["granted_role", "TEXT NOT NULL DEFAULT 'user'"],
      ["created_by", "TEXT"],
      ["code_encrypted", "TEXT"],
      ["code_hint", "TEXT"],
    ])
      if (!columns.has(column))
        db.exec(
          `ALTER TABLE signup_invitations ADD COLUMN ${column} ${definition}`,
        );
  }
  encrypt(code, id) {
    if (!this.key) return null;
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([
      cipher.update(code, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      "base64",
    );
  }
  decrypt(value, id) {
    const data = Buffer.from(value, "base64"),
      decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        data.subarray(0, 12),
      );
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([
      decipher.update(data.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  }
  create({ days = 7, label = "", role = "user", createdBy = null } = {}) {
    if (!["user", "admin"].includes(role))
      throw new InputError("邀请码权限无效");
    if (!Number.isInteger(days) || days < 1 || days > 365)
      throw new InputError("有效天数必须是 1–365 的整数");
    if (
      typeof label !== "string" ||
      label.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(label)
    )
      throw new InputError("备注限 80 个普通字符");
    const token = randomBytes(20).toString("hex").toUpperCase();
    const code = "KW-" + token.match(/.{8}/g).join("-"),
      id = randomUUID(),
      createdAt = this.now(),
      expiresAt = createdAt + days * DAY;
    this.db
      .prepare(
        "INSERT INTO signup_invitations(id,code_hash,label,created_at,expires_at,granted_role,created_by,code_encrypted,code_hint) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        fingerprint(code),
        label.trim(),
        createdAt,
        expiresAt,
        role,
        createdBy,
        this.encrypt(code, id),
        token.slice(-8),
      );
    return { id, code, label: label.trim(), createdAt, expiresAt, role };
  }
  assertUsable(code) {
    const hash = fingerprint(code);
    if (!hash) throw denied(!code);
    const row = this.db
      .prepare(
        "SELECT id FROM signup_invitations WHERE code_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?",
      )
      .get(hash, this.now());
    if (!row) throw denied();
  }
  // Better Auth calls this inside its SQLite signup transaction. Any subsequent
  // user/account/session failure rolls the claim back together with the account.
  consume(code, email) {
    const hash = fingerprint(code);
    if (!hash) throw denied(!code);
    const now = this.now();
    const row = this.db
      .prepare(
        "UPDATE signup_invitations SET used_at=?,used_email=?,code_encrypted=NULL WHERE code_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>? RETURNING id,granted_role",
      )
      .get(now, email, hash, now);
    if (!row) throw denied();
    return row.granted_role;
  }
  list({ reveal = false } = {}) {
    const now = this.now();
    return this.db
      .prepare(
        "SELECT id,label,created_at,expires_at,used_at,used_email,revoked_at,granted_role,created_by,code_encrypted,code_hint FROM signup_invitations ORDER BY created_at DESC,id",
      )
      .all()
      .map((r) => {
        const available =
          r.used_at === null && r.revoked_at === null && r.expires_at > now;
        let code = null,
          displayError = "";
        if (reveal && available && r.code_encrypted && this.key) {
          try {
            code = this.decrypt(r.code_encrypted, r.id);
          } catch {
            displayError = "无法解密，请恢复原登录密钥，或撤销后重新生成。";
          }
        }
        return {
          id: r.id,
          label: r.label,
          status:
            r.used_at !== null
              ? "used"
              : r.revoked_at !== null
                ? "revoked"
                : r.expires_at <= now
                  ? "expired"
                  : "available",
          createdAt: r.created_at,
          expiresAt: r.expires_at,
          usedAt: r.used_at,
          usedEmail: r.used_email,
          revokedAt: r.revoked_at,
          role: r.granted_role,
          createdBy: r.created_by,
          hint: r.code_hint,
          ...(reveal ? { code, displayError } : {}),
        };
      });
  }
  revoke(id) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
      throw new InputError("邀请码标识无效");
    const found = this.list().find((r) => r.id === id);
    if (!found) throw new InputError("邀请码不存在", 404);
    if (found.status === "used")
      throw new InputError("此邀请码已使用；撤销邀请码不会注销已有账号", 409);
    const updated = this.db
      .prepare(
        "UPDATE signup_invitations SET revoked_at=COALESCE(revoked_at,?),code_encrypted=NULL WHERE id=? AND used_at IS NULL",
      )
      .run(this.now(), id);
    if (!updated.changes)
      throw new InputError("此邀请码已使用；撤销邀请码不会注销已有账号", 409);
    return this.list().find((r) => r.id === id);
  }
}
export function invitationHooks(invites) {
  return {
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-up/email")
          invites.assertUsable(ctx.body?.inviteCode);
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            if (ctx?.path !== "/sign-up/email") throw denied(true);
            const role = invites.consume(ctx.body?.inviteCode, user.email);
            return { data: { ...user, role } };
          },
        },
      },
    },
  };
}
