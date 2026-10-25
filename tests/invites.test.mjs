import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { backup, DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.mjs";
import { InvitationStore } from "../server/invites.mjs";

const execute = promisify(execFile);
const password = randomBytes(20).toString("base64url");
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "keyword-invites-"));
  const seedFile = path.join(directory, "seed.json");
  const legacyFile = path.join(directory, "legacy.json");
  fs.writeFileSync(
    seedFile,
    JSON.stringify([
      {
        id: "builtin-test",
        title: "公共词库",
        words: [{ id: "one", term: "one", meaning: "一" }],
      },
    ]),
  );
  fs.writeFileSync(legacyFile, "{}");
  const reservation = http.createServer();
  await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const base = `http://127.0.0.1:${port}`;
  const options = {
    dataDir: directory,
    seedFile,
    legacyFile,
    origin: base,
    secret: randomBytes(48).toString("base64url"),
  };
  let app = await createApp(options);
  await new Promise((r) => app.server.listen(port, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    get app() {
      return app;
    },
    directory,
    base,
    async restart({ legacy = false } = {}) {
      await app.close();
      if (legacy) {
        const db = new DatabaseSync(path.join(directory, "keyword.sqlite"));
        db.exec("ALTER TABLE user DROP COLUMN role");
        for (const column of [
          "granted_role",
          "created_by",
          "code_encrypted",
          "code_hint",
        ])
          db.exec(`ALTER TABLE signup_invitations DROP COLUMN ${column}`);
        db.close();
      }
      await new Promise(setImmediate);
      app = await createApp(options);
      await new Promise((r) => app.server.listen(port, "127.0.0.1", r));
    },
    async call(
      url,
      body,
      { cookie = "", headers = {}, method = body ? "POST" : "GET" } = {},
    ) {
      const response = await fetch(base + url, {
        method,
        headers: {
          Origin: base,
          Connection: "close",
          Cookie: cookie,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
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
        cookie: response.headers
          .getSetCookie()
          .map((x) => x.split(";")[0])
          .join("; "),
      };
    },
    signup(code, email = "invite@example.test", rest = {}) {
      return this.call("/api/auth/sign-up/email", {
        name: "受邀用户",
        email,
        password,
        inviteCode: code,
        ...rest,
      });
    },
  };
}
function counts(db) {
  return ["user", "account", "session"].map(
    (table) => db.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n,
  );
}

test("Signup requires a valid body invitation before password hashing; SDK calls cannot bypass it", async (t) => {
  const f = await fixture(t);
  const context = await f.app.auth.$context;
  const original = context.password.hash;
  let hashes = 0;
  context.password.hash = async (...args) => {
    hashes++;
    return original(...args);
  };
  for (const [code, expected] of [
    [undefined, "INVITE_REQUIRED"],
    ["invalid", "INVITE_INVALID"],
  ]) {
    const response = await f.signup(code);
    assert.equal(response.status, 403);
    assert.equal(response.data.code, expected);
    assert.equal(response.cookie, "");
  }
  const invite = f.app.invites.create();
  const spoof = await f.call(
    "/api/auth/sign-up/email?inviteCode=" + invite.code,
    { name: "Spoof", email: "spoof@example.test", password },
    { headers: { "X-Invite-Code": invite.code } },
  );
  assert.equal(spoof.status, 403);
  await assert.rejects(
    f.app.auth.api.signUpEmail({
      body: {
        name: "SDK",
        email: "sdk@example.test",
        password,
      },
    }),
    { status: "FORBIDDEN" },
  );
  await assert.rejects(
    context.internalAdapter.createUser({
      name: "Internal",
      email: "internal@example.test",
      emailVerified: false,
    }),
    { status: "FORBIDDEN" },
  );
  assert.equal(hashes, 0);
  assert.deepEqual(counts(f.app.db), [0, 0, 0]);
  assert.equal(f.app.invites.list()[0].status, "available");
});

test("One-use invitations tolerate pasted formatting and are never stored or exported as plaintext", async (t) => {
  const f = await fixture(t),
    invite = f.app.invites.create({ label: "Friend" });
  const row = f.app.db.prepare("SELECT * FROM signup_invitations").get();
  assert.match(row.code_hash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(row).includes(invite.code));
  const response = await f.signup(
    "  " + invite.code.toLowerCase().replaceAll("-", " ") + "  ",
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.ok(response.cookie);
  assert.equal(f.app.invites.list()[0].status, "used");
  assert.equal(f.app.invites.list()[0].usedEmail, "invite@example.test");
  assert.equal(
    (await f.signup(invite.code, "second@example.test")).status,
    403,
  );
  assert.deepEqual(counts(f.app.db), [1, 1, 1]);
  const exported = await f.call("/api/export", undefined, {
    cookie: response.cookie,
  });
  assert.equal(exported.status, 200);
  for (const secret of [
    invite.code,
    row.code_hash,
    "signup_invitations",
    "inviteCode",
  ])
    assert.ok(!JSON.stringify(exported.data).includes(secret));
  assert.ok(!JSON.stringify(f.app.invites.list()).includes(row.code_hash));
  for (const route of [
    "/api/invites",
    "/api/auth/invites",
    "/data/keyword.sqlite",
    "/tools/invite.mjs",
  ])
    assert.notEqual((await f.call(route)).status, 200);
  assert.equal(
    (await f.call("/api/catalog", undefined, { cookie: response.cookie })).data
      .decks.length,
    1,
  );
  assert.equal(
    (
      await f.call("/api/decks/builtin-test", undefined, {
        cookie: response.cookie,
      })
    ).status,
    200,
  );
});

test("Expired and revoked invitations are rejected, and revocation never deletes an existing account", async (t) => {
  const f = await fixture(t);
  const old = new InvitationStore(f.app.db, {
    now: () => Date.now() - 8 * 86400000,
  }).create();
  const revoked = f.app.invites.create();
  assert.equal(f.app.invites.revoke(revoked.id).status, "revoked");
  for (const invite of [old, revoked])
    assert.equal((await f.signup(invite.code)).status, 403);
  assert.deepEqual(counts(f.app.db), [0, 0, 0]);
  assert.equal(
    f.app.invites.list().find((x) => x.id === old.id).status,
    "expired",
  );
  const used = f.app.invites.create();
  assert.equal((await f.signup(used.code)).status, 200);
  assert.throws(() => f.app.invites.revoke(used.id), { status: 409 });
  assert.equal(counts(f.app.db)[0], 1);
  assert.throws(() => f.app.invites.create({ days: 0 }));
  assert.throws(() => f.app.invites.create({ days: 366 }));
  assert.throws(() => f.app.invites.create({ label: "bad\nlabel" }));
});

test("Invalid signup fields and duplicate email preserve an unused invitation", async (t) => {
  const f = await fixture(t),
    invite = f.app.invites.create();
  assert.equal(
    (await f.signup(invite.code, "one@example.test", { password: "short" }))
      .status,
    400,
  );
  assert.equal((await f.signup(invite.code, "invalid-email")).status, 400);
  assert.equal(f.app.invites.list()[0].status, "available");
  assert.equal((await f.signup(f.app.invites.create().code)).status, 200);
  assert.equal((await f.signup(invite.code)).status, 422);
  assert.equal(
    f.app.invites.list().find((x) => x.id === invite.id).status,
    "available",
  );
  assert.equal((await f.signup(invite.code, "next@example.test")).status, 200);
});

for (const table of ["account", "session"]) {
  test(`A failed ${table} insert rolls back user creation and invitation use atomically`, async (t) => {
    const f = await fixture(t),
      invite = f.app.invites.create();
    f.app.db.exec(
      `CREATE TRIGGER signup_fault BEFORE INSERT ON "${table}" BEGIN SELECT RAISE(ABORT, 'injected signup failure'); END;`,
    );
    const failed = await f.signup(invite.code);
    assert.ok(failed.status >= 400);
    assert.equal(failed.cookie, "");
    assert.deepEqual(counts(f.app.db), [0, 0, 0]);
    assert.equal(f.app.invites.list()[0].status, "available");
    f.app.db.exec("DROP TRIGGER signup_fault");
    assert.equal((await f.signup(invite.code)).status, 200);
    assert.deepEqual(counts(f.app.db), [1, 1, 1]);
    assert.equal(f.app.invites.list()[0].status, "used");
  });
}

test("Concurrent signup with the same code creates exactly one account", async (t) => {
  const f = await fixture(t),
    invite = f.app.invites.create();
  const responses = await Promise.all([
    f.signup(invite.code, "first@example.test"),
    f.signup(invite.code, "second@example.test"),
  ]);
  assert.deepEqual(responses.map((x) => x.status).sort(), [200, 403]);
  assert.deepEqual(counts(f.app.db), [1, 1, 1]);
  assert.equal(f.app.invites.list()[0].status, "used");
});

test("A pending signup transaction cannot overlap or lose an authenticated library write", async (t) => {
  const f = await fixture(t);
  const existing = await f.signup(f.app.invites.create().code);
  const code = f.app.invites.create().code;
  const context = await f.app.auth.$context,
    original = context.password.hash;
  let entered, release;
  const hashing = new Promise((r) => {
    entered = r;
  });
  const resume = new Promise((r) => {
    release = r;
  });
  context.password.hash = async (...args) => {
    entered();
    await resume;
    return original(...args);
  };
  const signup = f.signup(code, "new@example.test");
  await hashing;
  const save = f.call(
    "/api/decks",
    { title: "Concurrent write", words: [{ term: "safe", meaning: "安全" }] },
    { cookie: existing.cookie },
  );
  release();
  const responses = await Promise.all([signup, save]);
  assert.deepEqual(
    responses.map((x) => x.status),
    [200, 201],
    JSON.stringify(responses.map((x) => x.data)),
  );
  assert.equal(
    (await f.call("/api/decks", undefined, { cookie: existing.cookie })).data
      .decks.length,
    1,
  );
  assert.deepEqual(counts(f.app.db), [2, 2, 2]);
});

test("An incomplete signup upload does not hold the database gate", async (t) => {
  const f = await fixture(t);
  const upload = http.request(f.base + "/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      Origin: f.base,
      "Content-Type": "application/json",
      "Content-Length": 1000,
    },
  });
  upload.on("error", () => {});
  upload.write('{"email":');
  t.after(() => upload.destroy());
  const response = await fetch(f.base + "/api/health", {
    signal: AbortSignal.timeout(2000),
    headers: { Connection: "close" },
  });
  assert.equal(response.status, 200);
  upload.destroy();
});

test("Invalid invitation requests still hit signup rate limiting; forwarded IP headers cannot reset it", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 6; i++) {
    const r = await f.call(
      "/api/auth/sign-up/email",
      {
        name: "Limit",
        email: "limit@example.test",
        password,
        inviteCode: "bad",
      },
      {
        headers: {
          "X-Forwarded-For": `192.0.2.${i}`,
          "X-Keyword-Client-IP": `192.0.2.${i}`,
        },
      },
    );
    assert.equal(r.status, i < 5 ? 403 : 429);
  }
  assert.deepEqual(counts(f.app.db), [0, 0, 0]);
});

test("Existing sessions and login work without an invitation after restart; backups preserve invitation state", async (t) => {
  const f = await fixture(t),
    used = f.app.invites.create(),
    unused = f.app.invites.create();
  const registered = await f.signup(used.code);
  const revoked = f.app.invites.create();
  f.app.invites.revoke(revoked.id);
  const copy = path.join(f.directory, "backup.sqlite");
  await backup(f.app.db, copy);
  const restored = new DatabaseSync(copy);
  try {
    assert.deepEqual(
      new InvitationStore(restored).list(),
      f.app.invites.list(),
    );
  } finally {
    restored.close();
  }
  await f.restart();
  assert.equal(
    (await f.call("/api/me", undefined, { cookie: registered.cookie })).data
      .user.email,
    "invite@example.test",
  );
  assert.equal(
    (
      await f.call("/api/auth/sign-in/email", {
        email: "invite@example.test",
        password,
      })
    ).status,
    200,
  );
  assert.equal((await f.signup(used.code, "reuse@example.test")).status, 403);
  assert.equal((await f.signup(unused.code, "new@example.test")).status, 200);
  assert.equal(
    (await f.signup(revoked.code, "revoked@example.test")).status,
    403,
  );
});

test("Administrator CLI creates, lists and revokes invitations without reprinting their codes", async (t) => {
  const f = await fixture(t);
  const command = (...args) =>
    execute(process.execPath, ["tools/invite.mjs", ...args], {
      cwd: new URL("../", import.meta.url),
      env: { ...process.env, DATA_DIR: f.directory },
    });
  const created = (
    await command("create", "--days", "3", "--label", "CLI friend")
  ).stdout;
  const code = created.match(/KW-(?:[A-F0-9]{8}-){4}[A-F0-9]{8}/)?.[0];
  assert.ok(code);
  const invite = f.app.invites.list()[0];
  assert.equal(invite.label, "CLI friend");
  assert.equal(invite.expiresAt - invite.createdAt, 3 * 86400000);
  const listed = (await command("list")).stdout;
  assert.ok(listed.includes(invite.id));
  assert.ok(!listed.includes(code));
  assert.match((await command("revoke", invite.id)).stdout, /已撤销/);
  assert.equal((await f.signup(code)).status, 403);
  await assert.rejects(command("create", "--days", "0"), { code: 1 });
});

test("All library, learning, history and legacy data require login; only auth and minimal health stay public", async (t) => {
  const f = await fixture(t);
  for (const url of [
    "/api/catalog",
    "/api/decks",
    "/api/decks/builtin-test",
    "/api/sessions",
    "/api/learning",
    "/api/learning/reviews",
    "/api/export",
    "/api/board",
    "/api/dump",
    "/api/admin/invitations",
  ]) {
    const r = await f.call(url);
    assert.equal(r.status, 401, url);
    assert.equal(r.data.code, "LOGIN_REQUIRED");
  }
  assert.equal((await f.call("/api/me")).data.user, null);
  assert.deepEqual((await f.call("/api/health")).data, { ok: true });
  const regular = await f.signup(f.app.invites.create().code);
  assert.equal(
    (await f.call("/api/catalog", undefined, { cookie: regular.cookie }))
      .status,
    200,
  );
});

test("Only administrator invitations grant admin; regular accounts cannot elevate themselves or operate management APIs", async (t) => {
  const f = await fixture(t);
  const bootstrap = f.app.invites.create({ role: "admin" });
  const admin = await f.signup(bootstrap.code, "owner@example.test");
  assert.equal(admin.status, 200, JSON.stringify(admin.data));
  assert.equal(
    (await f.call("/api/me", undefined, { cookie: admin.cookie })).data.user
      .role,
    "admin",
  );
  const created = await f.call(
    "/api/admin/invitations",
    { label: "朋友", days: 3, role: "admin" },
    { cookie: admin.cookie },
  );
  assert.equal(created.status, 201);
  assert.equal(created.data.invitation.role, "user");
  const user = await f.signup(
    created.data.invitation.code,
    "friend@example.test",
  );
  assert.equal(user.status, 200);
  assert.equal(
    (await f.call("/api/me", undefined, { cookie: user.cookie })).data.user
      .role,
    "user",
  );
  for (const [url, body] of [
    ["/api/admin/invitations", undefined],
    ["/api/admin/invitations", { label: "Attack", role: "admin" }],
    [`/api/admin/invitations/${bootstrap.id}/revoke`, {}],
  ])
    assert.equal(
      (
        await f.call(url, body, {
          cookie: user.cookie,
          headers: { "X-Role": "admin" },
        })
      ).status,
      403,
    );
  await f.call(
    "/api/auth/update-user",
    { role: "admin", name: "Unchanged permissions" },
    { cookie: user.cookie },
  );
  assert.equal(
    (await f.call("/api/me", undefined, { cookie: user.cookie })).data.user
      .role,
    "user",
  );
  const forgery = await f.signup(
    f.app.invites.create().code,
    "forged@example.test",
    { role: "admin" },
  );
  if (forgery.status === 200) assert.equal(forgery.data.user.role, "user");
  else assert.equal(forgery.status, 400);
});

test("Administrator web invitations remain viewable after restart, encrypted at rest, and revocable", async (t) => {
  const f = await fixture(t);
  const admin = await f.signup(f.app.invites.create({ role: "admin" }).code);
  const options = { cookie: admin.cookie };
  const made = await f.call(
    "/api/admin/invitations",
    { label: "持久化", days: 7 },
    options,
  );
  assert.equal(made.status, 201);
  const invite = made.data.invitation;
  const row = f.app.db
    .prepare("SELECT * FROM signup_invitations WHERE id=?")
    .get(invite.id);
  assert.ok(row.code_encrypted);
  assert.ok(!JSON.stringify(row).includes(invite.code));
  assert.equal(row.created_by, admin.data.user.id);
  assert.ok(!JSON.stringify(f.app.invites.list()).includes(invite.code));
  assert.ok(
    !JSON.stringify(
      (await f.call("/api/export", undefined, options)).data,
    ).includes(invite.code),
  );
  await f.restart();
  const listed = await f.call("/api/admin/invitations", undefined, options);
  assert.equal(listed.status, 200);
  assert.equal(
    listed.data.invitations.find((r) => r.id === invite.id).code,
    invite.code,
  );
  assert.equal(
    (await f.call(`/api/admin/invitations/${invite.id}/revoke`, {}, options))
      .status,
    200,
  );
  assert.equal(
    (await f.signup(invite.code, "revoked@example.test")).status,
    403,
  );
  assert.equal(
    f.app.db
      .prepare("SELECT code_encrypted FROM signup_invitations WHERE id=?")
      .get(invite.id).code_encrypted,
    null,
  );
  const used = (await f.call("/api/admin/invitations", {}, options)).data
    .invitation;
  assert.equal((await f.signup(used.code, "used@example.test")).status, 200);
  assert.equal(
    f.app.db
      .prepare("SELECT code_encrypted FROM signup_invitations WHERE id=?")
      .get(used.id).code_encrypted,
    null,
  );
});

test("Admin mutations preserve origin, account-generation and input validation boundaries", async (t) => {
  const f = await fixture(t),
    admin = await f.signup(f.app.invites.create({ role: "admin" }).code);
  const options = { cookie: admin.cookie };
  assert.equal(
    (await f.call("/api/admin/invitations", { days: 0 }, options)).status,
    400,
  );
  assert.equal(
    (await f.call("/api/admin/invitations", { days: 366 }, options)).status,
    400,
  );
  assert.equal(
    (await f.call("/api/admin/invitations", { label: "\n" }, options)).status,
    400,
  );
  assert.equal(
    (
      await f.call(
        "/api/admin/invitations",
        {},
        { ...options, headers: { Origin: "https://attacker.test" } },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        "/api/admin/invitations",
        {},
        { ...options, headers: { "X-Keyword-User": "another-account" } },
      )
    ).status,
    409,
  );
  assert.equal(f.app.invites.list().length, 1);
  f.app.db
    .prepare("UPDATE user SET role='user' WHERE id=?")
    .run(admin.data.user.id);
  assert.equal(
    (await f.call("/api/admin/invitations", undefined, options)).status,
    403,
  );
});

test("Old accounts and invitation hashes migrate as ordinary users without changing sessions or ownership", async (t) => {
  const f = await fixture(t),
    registered = await f.signup(f.app.invites.create().code),
    pending = f.app.invites.create();
  await f.restart({ legacy: true });
  const me = await f.call("/api/me", undefined, { cookie: registered.cookie });
  assert.equal(me.data.user.id, registered.data.user.id);
  assert.equal(me.data.user.role, "user");
  assert.equal(
    (
      await f.call("/api/admin/invitations", undefined, {
        cookie: registered.cookie,
      })
    ).status,
    403,
  );
  assert.equal(
    f.app.invites.list().find((r) => r.id === pending.id).role,
    "user",
  );
  assert.equal(
    (await f.signup(pending.code, "migrated@example.test")).status,
    200,
  );
});

test("Authenticated invitation display detects ciphertext swaps and changed secrets without exposing plaintext", async (t) => {
  const f = await fixture(t),
    first = f.app.invites.create(),
    second = f.app.invites.create();
  const ciphertext = f.app.db
    .prepare("SELECT code_encrypted FROM signup_invitations WHERE id=?")
    .get(first.id).code_encrypted;
  f.app.db
    .prepare("UPDATE signup_invitations SET code_encrypted=? WHERE id=?")
    .run(ciphertext, second.id);
  const swapped = f.app.invites
    .list({ reveal: true })
    .find((r) => r.id === second.id);
  assert.equal(swapped.code, null);
  assert.ok(swapped.displayError);
  const wrongKey = new InvitationStore(f.app.db, {
    secret: randomBytes(48).toString("base64url"),
  });
  assert.ok(
    wrongKey
      .list({ reveal: true })
      .every((r) => r.code === null && r.displayError),
  );
});
