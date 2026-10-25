import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createApp } from "../server/app.mjs";
let app, base, port, a, b, privateDeck;
const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "keyword-integration-"),
  ),
  secret = randomBytes(48).toString("base64url"),
  password = randomBytes(16).toString("base64url");
const publicDir = path.join(directory, "public");
fs.mkdirSync(path.join(publicDir, "assets"), { recursive: true });
fs.writeFileSync(
  path.join(publicDir, "index.html"),
  "<!doctype html><title>test fixture</title>",
);
fs.writeFileSync(path.join(directory, "private-proof"), "PRIVATE");
fs.symlinkSync(
  path.join(directory, "private-proof"),
  path.join(publicDir, "assets", "leak.js"),
);
async function launch() {
  await new Promise(setImmediate);
  app = await createApp({
    dataDir: directory,
    origin: base,
    secret,
    publicDir,
  });
  await new Promise((resolve) => app.server.listen(port, "127.0.0.1", resolve));
}
function client() {
  const cookies = new Map();
  let userId = null;
  return {
    get userId() {
      return userId;
    },
    async request(
      url,
      { method = "GET", body, origin = base, raw, headers = {} } = {},
    ) {
      const response = await fetch(base + url, {
        method,
        headers: {
          ...(origin ? { Origin: origin } : {}),
          ...(body !== undefined || raw !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
          ...(cookies.size
            ? { Cookie: [...cookies].map(([k, v]) => k + "=" + v).join("; ") }
            : {}),
          ...(userId && !url.startsWith("/api/auth/") && url !== "/api/me"
            ? { "X-Keyword-User": userId }
            : {}),
          ...headers,
        },
        body:
          raw !== undefined
            ? raw
            : body !== undefined
              ? JSON.stringify(body)
              : undefined,
      });
      for (const cookie of response.headers.getSetCookie()) {
        const first = cookie.split(";")[0],
          i = first.indexOf("=");
        cookies.set(first.slice(0, i), first.slice(i + 1));
      }
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      if (url.startsWith("/api/auth/") && data.user) userId = data.user.id;
      return { status: response.status, data, headers: response.headers };
    },
  };
}
before(async () => {
  const reservation = http.createServer();
  await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
  port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  base = "http://127.0.0.1:" + port;
  await launch();
  a = client();
  b = client();
  for (const [c, name] of [
    [a, "Alice"],
    [b, "Bob"],
  ]) {
    const r = await c.request("/api/auth/sign-up/email", {
      method: "POST",
      body: {
        name,
        email: name.toLowerCase() + "@example.test",
        password,
        inviteCode: app.invites.create().code,
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(c.userId);
    assert.match(r.headers.getSetCookie().join(";"), /HttpOnly/i);
  }
});
after(async () => {
  await app?.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
test("Private libraries are isolated for listing, direct reads, edits, deletion and export", async () => {
  const raw = {
    title: "我的 <安全> 词库",
    description: "private",
    words: [
      { term: "résumé", meaning: "<img src=x onerror=alert(1)>" },
      { term: "GPT-4", meaning: "模型" },
    ],
  };
  const created = await a.request("/api/decks", { method: "POST", body: raw });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  privateDeck = created.data.deck;
  assert.equal(privateDeck.version, 1);
  assert.equal((await b.request("/api/decks")).data.decks.length, 0);
  assert.equal(
    (await client().request("/api/decks/" + privateDeck.id)).status,
    401,
  );
  assert.equal((await b.request("/api/decks/" + privateDeck.id)).status, 404);
  assert.equal(
    (
      await b.request("/api/decks/" + privateDeck.id, {
        method: "PUT",
        body: { ...raw, version: 1 },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await b.request("/api/decks/" + privateDeck.id, {
        method: "DELETE",
        body: { version: 1 },
      })
    ).status,
    404,
  );
  assert.equal((await b.request("/api/export")).data.decks.length, 0);
  assert.equal(
    (
      await a.request("/api/decks", {
        method: "POST",
        headers: { "X-Keyword-User": b.userId },
        body: raw,
      })
    ).status,
    409,
  );
});
test("Two independently logged-in devices synchronize, stale edits conflict instead of overwriting", async () => {
  const device = client();
  assert.equal(
    (
      await device.request("/api/auth/sign-in/email", {
        method: "POST",
        body: { email: "alice@example.test", password },
      })
    ).status,
    200,
  );
  const original = (await device.request("/api/decks/" + privateDeck.id)).data
    .deck;
  assert.deepEqual(original.words, privateDeck.words);
  const saved = await a.request("/api/decks/" + privateDeck.id, {
    method: "PUT",
    body: { ...privateDeck, title: "设备一的新名称" },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.deck.version, 2);
  const conflict = await device.request("/api/decks/" + privateDeck.id, {
    method: "PUT",
    body: { ...original, title: "设备二的旧草稿" },
  });
  assert.equal(conflict.status, 409);
  assert.equal(
    (await device.request("/api/decks/" + privateDeck.id)).data.deck.title,
    "设备一的新名称",
  );
});
test("Imports are atomic and retrying the same operation never creates duplicate decks", async () => {
  const payload = {
      title: "导入的词库",
      words: [{ id: randomUUID(), term: "comet", meaning: "彗星" }],
    },
    count = (await a.request("/api/decks")).data.decks.length;
  const invalid = await a.request("/api/decks/import", {
    method: "POST",
    body: { decks: [payload, { title: "bad", words: [{ term: "🙂" }] }] },
  });
  assert.equal(invalid.status, 400);
  assert.equal((await a.request("/api/decks")).data.decks.length, count);
  const body = { decks: [payload], operationId: randomUUID() };
  const first = await a.request("/api/decks/import", { method: "POST", body }),
    again = await a.request("/api/decks/import", { method: "POST", body });
  assert.equal(first.status, 201);
  assert.equal(again.data.decks[0].id, first.data.decks[0].id);
  assert.equal((await a.request("/api/decks")).data.decks.length, count + 1);
  assert.equal(
    (
      await a.request("/api/decks/import", {
        method: "POST",
        body: { ...body, decks: [{ ...payload, title: "changed" }] },
      })
    ).status,
    409,
  );
});
test("A write error returns failure and transaction rollback keeps the previous deck intact", async () => {
  const current = (await a.request("/api/decks/" + privateDeck.id)).data.deck;
  app.db.exec(
    "CREATE TRIGGER audit_fail BEFORE UPDATE ON decks BEGIN SELECT RAISE(ABORT,'simulated write failure'); END;",
  );
  try {
    assert.equal(
      (
        await a.request("/api/decks/" + privateDeck.id, {
          method: "PUT",
          body: { ...current, title: "不应保存" },
        })
      ).status,
      500,
    );
  } finally {
    app.db.exec("DROP TRIGGER audit_fail");
  }
  const after = (await a.request("/api/decks/" + privateDeck.id)).data.deck;
  assert.equal(after.title, current.title);
  assert.equal(after.version, current.version);
  assert.deepEqual(after.words, current.words);
});
test("Session records are per-round, idempotent, versioned and private; export includes all history", async () => {
  const session = {
    id: randomUUID(),
    deckId: privateDeck.id,
    deckVersion: 1,
    durationMs: 1234,
    keystrokes: 12,
    correct: 11,
    wordsDone: 2,
    skipped: 0,
    best: 8,
    words: privateDeck.words.map((w) => ({
      id: w.id,
      status: "completed",
      mistakes: 0,
    })),
  };
  const saved = await a.request("/api/sessions", {
    method: "POST",
    body: session,
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  assert.equal(saved.data.session.title, privateDeck.title);
  assert.equal(
    saved.data.session.words[0].meaning,
    privateDeck.words[0].meaning,
  );
  await a.request("/api/sessions", { method: "POST", body: session });
  assert.equal((await a.request("/api/sessions")).data.sessions.length, 1);
  assert.equal((await b.request("/api/sessions")).data.sessions.length, 0);
  assert.equal(
    (
      await b.request("/api/sessions", {
        method: "POST",
        body: { ...session, id: randomUUID() },
      })
    ).status,
    404,
  );
  for (let i = 0; i < 102; i++)
    app.store.saveSession(a.userId, { ...session, id: randomUUID() });
  assert.equal((await a.request("/api/sessions")).data.sessions.length, 100);
  assert.equal((await a.request("/api/export")).data.sessions.length, 103);
});
test("Trash is reversible and never deletes practice history", async () => {
  const d = (await a.request("/api/decks/" + privateDeck.id)).data.deck;
  assert.equal(
    (
      await a.request("/api/decks/" + d.id, {
        method: "DELETE",
        body: { version: d.version },
      })
    ).status,
    200,
  );
  assert.equal((await a.request("/api/decks/" + d.id)).status, 404);
  const trash = (await a.request("/api/decks?trash=1")).data.decks;
  assert.equal(trash.length, 1);
  assert.equal(
    (
      await a.request("/api/decks/" + d.id + "/restore", {
        method: "POST",
        body: { version: trash[0].version },
      })
    ).status,
    200,
  );
  assert.equal((await a.request("/api/decks/" + d.id)).status, 200);
  assert.equal((await a.request("/api/sessions")).data.sessions.length, 100);
});
test("Malformed requests cannot crash the server or expose source, secrets or adjacent directories", async () => {
  for (const url of [
    "/server.js",
    "/.git/HEAD",
    "/package.json",
    "/data/keyword.sqlite",
    "/seed/decks.json",
    "/node_modules/better-auth/package.json",
    "/assets/leak.js",
    "/assets/../../server.js",
    "/%2e%2e%2fapp-sibling%2fproof.txt",
  ])
    assert.ok([400, 404].includes((await client().request(url)).status), url);
  assert.equal((await client().request("/%ZZ")).status, 400);
  assert.equal((await a.request("/api/board?bank=__proto__")).status, 200);
  assert.equal((await a.request("/api/board?bank=constructor")).status, 200);
  assert.equal(
    (await a.request("/api/decks", { method: "POST", raw: "null" })).status,
    400,
  );
  assert.equal(
    (await a.request("/api/decks", { method: "POST", raw: "{bad" })).status,
    400,
  );
  assert.equal(
    (
      await a.request("/api/decks", {
        method: "POST",
        raw: "x".repeat(3 * 1024 * 1024 + 1),
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await a.request("/api/decks", {
        method: "POST",
        body: { title: "csrf", words: [] },
        origin: "https://attacker.test",
      })
    ).status,
    403,
  );
  assert.equal((await client().request("/api/decks")).status, 401);
  assert.equal((await client().request("/api/health")).status, 200);
  const page = await client().request("/");
  assert.equal(page.status, 200);
  assert.match(
    page.headers.get("content-security-policy"),
    /script-src 'self'/,
  );
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
});
test("Legacy endpoints remain read-only and never include private account data", async () => {
  assert.equal(
    Object.hasOwn((await a.request("/api/dump")).data.data, "constructor"),
    false,
  );
  assert.equal(
    (
      await a.request("/api/score", {
        method: "POST",
        body: { bank: "mine", name: "Alice", time: 0.01 },
      })
    ).status,
    410,
  );
  assert.deepEqual((await a.request("/api/dump")).data.data, {});
});
test("Online database backup can be opened with complete accounts, libraries and history", async () => {
  const target = path.join(directory, "backup.sqlite");
  await promisify(execFile)(process.execPath, ["tools/backup.mjs", target], {
    env: { ...process.env, DATA_DIR: directory },
  });
  const db = new DatabaseSync(target, { readOnly: true });
  try {
    assert.equal(
      db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM user").get().n, 2);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM practice_sessions").get().n,
      103,
    );
  } finally {
    db.close();
  }
});
test("Restart retains accounts, active sessions, libraries and history", async () => {
  await app.close();
  await launch();
  assert.equal((await a.request("/api/me")).data.user.id, a.userId);
  assert.equal((await a.request("/api/decks/" + privateDeck.id)).status, 200);
  assert.equal((await a.request("/api/export")).data.sessions.length, 103);
  assert.equal((await b.request("/api/decks")).data.decks.length, 0);
});
test("Password changes revoke other devices; sign-out revokes the current session", async () => {
  const other = client();
  assert.equal(
    (
      await other.request("/api/auth/sign-in/email", {
        method: "POST",
        body: { email: "bob@example.test", password },
      })
    ).status,
    200,
  );
  const replacement = randomBytes(18).toString("base64url");
  assert.equal(
    (
      await b.request("/api/auth/change-password", {
        method: "POST",
        body: {
          currentPassword: password,
          newPassword: replacement,
          revokeOtherSessions: true,
        },
      })
    ).status,
    200,
  );
  assert.equal((await other.request("/api/me")).data.user, null);
  assert.equal(
    (await b.request("/api/auth/sign-out", { method: "POST", body: {} }))
      .status,
    200,
  );
  assert.equal((await b.request("/api/me")).data.user, null);
  assert.equal(
    (
      await b.request("/api/auth/sign-in/email", {
        method: "POST",
        body: { email: "bob@example.test", password: replacement },
      })
    ).status,
    200,
  );
});
test("Login rate limits persist and cannot be bypassed by spoofing forwarded IP headers", async () => {
  let limited = false;
  for (let i = 0; i < 15; i++) {
    const r = await client().request("/api/auth/sign-in/email", {
      method: "POST",
      body: { email: "nobody@example.test", password },
      headers: {
        "X-Forwarded-For": "192.0.2." + (i + 1),
        "X-Keyword-Client-Ip": "198.51.100." + (i + 1),
      },
    });
    if (r.status === 429) {
      limited = true;
      break;
    }
  }
  assert.equal(limited, true);
});

test("The largest built-in bank can be read, copied into a private account and edited with source attribution intact", async () => {
  const catalog = (await a.request("/api/catalog")).data.decks;
  assert.equal(catalog.length, 10);
  assert.ok(catalog.every((d) => d.id.startsWith("builtin-ecdict-")));
  const builtin = (await a.request("/api/decks/builtin-ecdict-gre")).data.deck;
  assert.equal(builtin.words.length, 7504);
  const copy = await a.request("/api/decks", {
    method: "POST",
    body: { ...builtin, title: "我的 GRE 副本" },
  });
  assert.equal(copy.status, 201, JSON.stringify(copy.data));
  assert.equal(copy.data.deck.words.length, 7504);
  assert.deepEqual(copy.data.deck.source, builtin.source);
  assert.equal(copy.data.deck.builtin, false);
  const { source, ...withoutSource } = copy.data.deck;
  const edited = await a.request("/api/decks/" + copy.data.deck.id, {
    method: "PUT",
    body: { ...withoutSource, title: "我的 GRE 计划" },
  });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.data.deck.source, source);
  assert.equal(
    (await b.request("/api/decks/" + copy.data.deck.id)).status,
    404,
  );
});
