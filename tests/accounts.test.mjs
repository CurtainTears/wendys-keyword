import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { createApp } from "../server/app.mjs";
import { flushAccountOutbox } from "../src/sync.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keyword-accounts-"));
const seedFile = path.join(dir, "decks.json"),
  legacyFile = path.join(dir, "legacy.json");
fs.writeFileSync(
  seedFile,
  JSON.stringify([
    {
      id: "builtin-test",
      title: "通用词库",
      words: [{ id: "one", term: "one", meaning: "一" }],
    },
  ]),
);
fs.writeFileSync(legacyFile, "{}");
const password = randomBytes(20).toString("base64url"),
  secret = randomBytes(48).toString("base64url");
let app, base, port, a, a2, b, deck;
function device() {
  const cookies = new Map();
  return {
    id: null,
    async request(url, { method = "GET", body, headers = {} } = {}) {
      const response = await fetch(base + url, {
        method,
        headers: {
          Connection: "close",
          Origin: base,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          Cookie: [...cookies].map(([k, v]) => k + "=" + v).join("; "),
          ...(this.id &&
          url !== "/api/me" &&
          !/^\/api\/auth\/sign-(?:in|up)\//.test(url)
            ? { "X-Keyword-User": this.id }
            : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const [first] = cookie.split(";"),
          split = first.indexOf("=");
        cookies.set(first.slice(0, split), first.slice(split + 1));
      }
      const data = await response.json();
      if (data.user) this.id = data.user.id;
      return { status: response.status, data, headers: response.headers };
    },
  };
}
async function launch() {
  app = await createApp({
    dataDir: dir,
    seedFile,
    legacyFile,
    origin: base,
    secret,
  });
  await new Promise((resolve) => app.server.listen(port, "127.0.0.1", resolve));
}
before(async () => {
  const reservation = http.createServer();
  await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
  port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  base = `http://127.0.0.1:${port}`;
  await launch();
  a = device();
  a2 = device();
  b = device();
});
after(async () => {
  await app?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Registration creates a real session, normalizes email, rejects duplicate/invalid credentials and stores no plaintext password", async () => {
  for (const [client, name] of [
    [a, "Alice"],
    [b, "Bob"],
  ]) {
    const r = await client.request("/api/auth/sign-up/email", {
      method: "POST",
      body: {
        name,
        email: name.toUpperCase() + "@example.test",
        password,
        inviteCode: app.invites.create().code,
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(
      (await client.request("/api/me")).data.user.email,
      name.toLowerCase() + "@example.test",
    );
    assert.match(r.headers.getSetCookie().join(";"), /HttpOnly/i);
  }
  const duplicate = await device().request("/api/auth/sign-up/email", {
    method: "POST",
    body: {
      name: "Not Alice",
      email: "alice@example.test",
      password,
      inviteCode: app.invites.create().code,
    },
  });
  assert.equal(duplicate.status, 422);
  const invalid = device();
  assert.equal(
    (
      await invalid.request("/api/auth/sign-in/email", {
        method: "POST",
        body: { email: "alice@example.test", password: "not-the-password" },
      })
    ).status,
    401,
  );
  assert.equal((await invalid.request("/api/me")).data.user, null);
  assert.equal((await invalid.request("/api/decks")).status, 401);
  const row = app.db
    .prepare("SELECT password FROM account WHERE userId=?")
    .get(a.id);
  assert.notEqual(row.password, password);
  assert.equal(
    JSON.stringify((await a.request("/api/me")).data).includes(row.password),
    false,
  );
});
test("A fresh device signs in with the same account and shares create/edit/trash/restore and full practice history", async () => {
  assert.equal(
    (
      await a2.request("/api/auth/sign-in/email", {
        method: "POST",
        body: { email: "alice@example.test", password },
      })
    ).status,
    200,
  );
  assert.equal(a2.id, a.id);
  deck = (
    await a.request("/api/decks", {
      method: "POST",
      body: { title: "设备 A 的词库", words: [{ term: "one", meaning: "一" }] },
    })
  ).data.deck;
  const onSecond = (await a2.request("/api/decks/" + deck.id)).data.deck;
  assert.deepEqual(onSecond, deck);
  deck = (
    await a2.request("/api/decks/" + deck.id, {
      method: "PUT",
      body: { ...onSecond, title: "设备 B 更新" },
    })
  ).data.deck;
  assert.equal(
    (await a.request("/api/decks")).data.decks[0].title,
    "设备 B 更新",
  );
  assert.equal(
    (
      await a.request("/api/decks/" + deck.id, {
        method: "PUT",
        body: onSecond,
      })
    ).status,
    409,
  );
  await a.request("/api/decks/" + deck.id, {
    method: "DELETE",
    body: { version: deck.version },
  });
  assert.equal((await a2.request("/api/decks")).data.decks.length, 0);
  const trashed = (await a2.request("/api/decks?trash=1")).data.decks[0];
  deck = (
    await a2.request("/api/decks/" + deck.id + "/restore", {
      method: "POST",
      body: { version: trashed.version },
    })
  ).data.deck;
  assert.equal((await a.request("/api/decks")).data.decks.length, 1);
  const result = round(deck);
  assert.equal(
    (await a.request("/api/sessions", { method: "POST", body: result })).status,
    201,
  );
  assert.equal(
    (await a2.request("/api/sessions")).data.sessions[0].id,
    result.id,
  );
  assert.deepEqual(
    (await a2.request("/api/export")).data.sessions,
    (await a.request("/api/export")).data.sessions,
  );
});
function round(deck, createdAt = new Date().toISOString()) {
  return {
    id: randomUUID(),
    deckId: deck.id,
    deckVersion: deck.version,
    createdAt,
    durationMs: 1500,
    keystrokes: 3,
    correct: 3,
    wordsDone: 1,
    skipped: 0,
    best: 3,
    words: [{ id: deck.words[0].id, status: "completed", mistakes: 0 }],
  };
}
test("Different accounts cannot read/mutate private libraries, trash or history, or claim data using a supplied owner ID", async () => {
  for (const url of ["/api/decks", "/api/decks?trash=1", "/api/sessions"]) {
    const r = await b.request(url);
    assert.deepEqual(r.data.decks || r.data.sessions, []);
  }
  assert.equal((await b.request("/api/decks/" + deck.id)).status, 404);
  for (const [method, suffix, body] of [
    ["PUT", "", deck],
    ["DELETE", "", { version: deck.version }],
    ["POST", "/restore", { version: deck.version }],
  ])
    assert.equal(
      (await b.request("/api/decks/" + deck.id + suffix, { method, body }))
        .status,
      404,
    );
  assert.equal(
    (
      await b.request("/api/sessions", {
        method: "POST",
        body: { ...round(deck), ownerId: a.id },
      })
    ).status,
    404,
  );
  const forged = await a.request("/api/decks", {
    method: "POST",
    body: { title: "仍属于 A", words: [], ownerId: b.id, owner_id: b.id },
  });
  assert.equal(forged.status, 201);
  assert.equal(
    (await b.request("/api/decks/" + forged.data.deck.id)).status,
    404,
  );
  const exported = (await b.request("/api/export")).data;
  assert.deepEqual(exported.decks, []);
  assert.deepEqual(exported.sessions, []);
});
test("Stale tabs cannot change a new account's password or sign it out", async () => {
  for (const [url, body] of [
    ["/api/auth/sign-out", {}],
    [
      "/api/auth/change-password",
      {
        currentPassword: password,
        newPassword: "should-never-be-used",
        revokeOtherSessions: true,
      },
    ],
  ]) {
    const denied = await b.request(url, {
      method: "POST",
      body,
      headers: { "X-Keyword-User": a.id },
    });
    assert.equal(denied.status, 409);
    assert.equal(denied.data.code, "ACCOUNT_CHANGED");
  }
  assert.equal((await b.request("/api/me")).data.user.id, b.id);
});
test("The app renews the browser's session cookie, not just the database expiry", async () => {
  app.db
    .prepare("UPDATE session SET updatedAt=?, expiresAt=? WHERE userId=?")
    .run(Date.now() - 2 * 86400000, Date.now() + 86400000, a.id);
  const r = await a.request("/api/me");
  assert.equal(r.data.user.id, a.id);
  assert.match(r.headers.getSetCookie().join(";"), /keyword\.session_token=/);
  assert.ok(
    new Date(
      app.db
        .prepare(
          "SELECT expiresAt FROM session WHERE userId=? ORDER BY expiresAt DESC LIMIT 1",
        )
        .get(a.id).expiresAt,
    ).getTime() >
      Date.now() + 20 * 86400000,
  );
});
test("An offline browser queue survives failed requests and restart, uploads once, and preserves actual completion time across devices", async () => {
  const result = round(deck, "2026-01-02T03:04:05.678Z"),
    pending = {
      id: a.id + ":" + result.id,
      ownerId: a.id,
      result,
      state: "pending",
    };
  const data = new Map([
    [pending.id, pending],
    ["other", { ...pending, id: "other", ownerId: b.id }],
  ]);
  const local = {
    all: async () => [...data.values()],
    put: async (_, x) => data.set(x.id, x),
    remove: async (_, id) => data.delete(id),
  };
  const options = {
    local,
    ownerId: a.id,
    isCurrent: () => true,
    send: async (body) => {
      const r = await a.request("/api/sessions", { method: "POST", body });
      if (r.status !== 201)
        throw Object.assign(new Error(r.data.error), { status: r.status });
    },
  };
  await app.close();
  assert.equal((await flushAccountOutbox(options)).pending.length, 1);
  assert.equal(data.size, 2);
  await launch();
  assert.equal((await flushAccountOutbox(options)).pending.length, 0);
  await options.send(result); // Response-lost replay has exactly the same stored result.
  const history = (await a2.request("/api/sessions")).data.sessions.filter(
    (x) => x.id === result.id,
  );
  assert.equal(history.length, 1);
  assert.equal(history[0].createdAt, result.createdAt);
  assert.equal(data.size, 1);
  assert.equal(data.get("other").ownerId, b.id);
});
test("Expired sessions retain queued results for their original account, then resume after signing in again", async () => {
  app.db
    .prepare("UPDATE session SET expiresAt=? WHERE userId=?")
    .run(Date.now() - 1, a.id);
  const expired = await a2.request("/api/sessions");
  assert.equal(expired.status, 401);
  assert.equal(expired.data.code, "SESSION_EXPIRED");
  assert.equal((await a2.request("/api/me")).data.user, null);
  const result = round(deck),
    queued = new Map([
      [result.id, { id: result.id, ownerId: a.id, result, state: "pending" }],
    ]);
  const local = {
    all: async () => [...queued.values()],
    put: async (_, x) => queued.set(x.id, x),
    remove: async (_, id) => queued.delete(id),
  };
  const options = {
    local,
    ownerId: a.id,
    isCurrent: () => true,
    send: async (body) => {
      const response = await a2.request("/api/sessions", {
        method: "POST",
        body,
      });
      if (response.status !== 201)
        throw Object.assign(new Error(response.data.error), {
          status: response.status,
        });
    },
  };
  assert.equal((await flushAccountOutbox(options)).pending.length, 1);
  assert.equal(queued.get(result.id).state, "pending");
  let sentToOtherAccount = false;
  await flushAccountOutbox({
    ...options,
    ownerId: b.id,
    send: async () => {
      sentToOtherAccount = true;
    },
  });
  assert.equal(sentToOtherAccount, false);
  assert.equal(
    (
      await a2.request("/api/auth/sign-in/email", {
        method: "POST",
        body: { email: "alice@example.test", password },
      })
    ).status,
    200,
  );
  assert.equal((await flushAccountOutbox(options)).pending.length, 0);
  assert.equal((await a2.request("/api/sessions")).data.sessions.length, 3);
  assert.equal((await b.request("/api/sessions")).data.sessions.length, 0);
});
