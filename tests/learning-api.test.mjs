import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { createApp } from "../server/app.mjs";
import { createPractice } from "../src/practice.mjs";
import { newId, targetFor } from "../shared/words.mjs";
import { DatabaseSync } from "node:sqlite";
import { backup } from "node:sqlite";
const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "keyword-learning-api-"),
);
const seedFile = path.join(directory, "seed.json"),
  legacyFile = path.join(directory, "legacy.json");
fs.writeFileSync(
  seedFile,
  JSON.stringify([
    {
      id: "builtin-learning",
      title: "整库学习验收",
      words: Array.from({ length: 65 }, (_, i) => ({
        id: "w" + i,
        term: "word" + i,
        meaning: "词" + i,
      })),
    },
  ]),
);
fs.writeFileSync(legacyFile, "{}");
const password = randomBytes(20).toString("base64url"),
  secret = randomBytes(48).toString("base64url");
let app, base, port, a, b, a2, round, privateDeck;
async function launch() {
  app = await createApp({
    dataDir: directory,
    seedFile,
    legacyFile,
    origin: base,
    secret,
  });
  await new Promise((r) => app.server.listen(port, "127.0.0.1", r));
}
function device() {
  let cookie = "";
  return {
    user: null,
    async call(url, { method = "GET", body, expected = this.user?.id } = {}) {
      const r = await fetch(base + url, {
        method,
        headers: {
          Connection: "close",
          Origin: base,
          Cookie: cookie,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(expected && !url.startsWith("/api/auth/") && url != "/api/me"
            ? { "X-Keyword-User": expected }
            : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const cookies = r.headers.getSetCookie();
      if (cookies.length)
        cookie = cookies.map((s) => s.split(";")[0]).join("; ");
      const data = await r.json();
      if (data.user) this.user = data.user;
      return { status: r.status, data };
    },
  };
}
const engine = (r) => {
  const p = createPractice({ clock: () => 0 });
  p.restore(
    { id: r.scopeId, title: r.title, version: r.deckVersion, words: r.words },
    r.checkpoint,
    r.id,
  );
  return p;
};
const start = async (c, deckId) => {
  const r = await c.call("/api/learning/rounds", {
    method: "POST",
    body: { deckId, operationId: newId() },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.round;
};
async function save(c, r, p, sequence = 1) {
  return c.call("/api/learning/rounds/" + r.id + "/checkpoint", {
    method: "POST",
    body: { generation: r.generation, sequence, checkpoint: p.snapshot() },
  });
}
async function finish(c, r, wrong = false) {
  const p = engine(r);
  for (const w of r.words) {
    if (wrong) p.input(w.term[0] === "z" ? "x" : "z");
    for (const ch of targetFor(w.term)) p.input(ch);
  }
  const result = await save(c, r, p);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data.round;
}
before(async () => {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  port = s.address().port;
  await new Promise((r) => s.close(r));
  base = "http://127.0.0.1:" + port;
  await launch();
  a = device();
  b = device();
  a2 = device();
  for (const [c, name] of [
    [a, "alice"],
    [b, "bob"],
  ])
    assert.equal(
      (
        await c.call("/api/auth/sign-up/email", {
          method: "POST",
          body: {
            name,
            email: name + "@example.test",
            password,
            inviteCode: app.invites.create().code,
          },
        })
      ).status,
      200,
    );
  assert.equal(
    (
      await a2.call("/api/auth/sign-in/email", {
        method: "POST",
        body: { email: "alice@example.test", password },
      })
    ).status,
    200,
  );
});
after(async () => {
  await app?.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
test("Round creation uses canonical words and idempotency; another device reads the exact unfinished input", async () => {
  privateDeck = (
    await a.call("/api/decks", {
      method: "POST",
      body: {
        title: "账号 A 的学习词库",
        words: [
          { term: "sun", meaning: "太阳" },
          { term: "moon", meaning: "月亮" },
        ],
      },
    })
  ).data.deck;
  const body = {
    deckId: privateDeck.id,
    operationId: newId(),
    words: [{ term: "fake" }],
    ownerId: b.user.id,
  };
  const first = await a.call("/api/learning/rounds", { method: "POST", body });
  assert.equal(first.status, 201);
  round = first.data.round;
  assert.deepEqual(
    new Set(round.words.map((w) => w.term)),
    new Set(["sun", "moon"]),
  );
  assert.equal(
    (await a.call("/api/learning/rounds", { method: "POST", body })).data.round
      .id,
    round.id,
  );
  const p = engine(round);
  p.input("z");
  p.input(round.words[0].term[0]);
  assert.equal((await save(a, round, p)).status, 200);
  const remote = (await a2.call("/api/learning/rounds/" + round.id)).data.round;
  assert.equal(remote.checkpoint.current.typed, 1);
  assert.equal(remote.checkpoint.keystrokes, 2);
  assert.equal((await a2.call("/api/learning")).data.summary.reviewCount, 1);
});
test("Every new learning endpoint is account-scoped, including claim, checkpoint, fork, review edits and exports", async () => {
  assert.deepEqual((await b.call("/api/learning")).data.summary.rounds, []);
  assert.deepEqual((await b.call("/api/learning/reviews")).data.reviews, []);
  for (const suffix of ["", "/claim", "/checkpoint", "/fork", "/retry"]) {
    const response = await b.call("/api/learning/rounds/" + round.id + suffix, {
      method: suffix ? "POST" : "GET",
      body: suffix
        ? {
            operationId: newId(),
            version: 2,
            generation: 1,
            sequence: 1,
            checkpoint: {},
            wordIds: ["item_0"],
          }
        : undefined,
    });
    assert.equal(response.status, 404, JSON.stringify(response.data));
  }
  assert.equal(
    (
      await b.call("/api/learning/rounds", {
        method: "POST",
        body: { deckId: privateDeck.id, operationId: newId() },
      })
    ).status,
    404,
  );
  const review = (await a.call("/api/learning/reviews")).data.reviews[0];
  assert.equal(
    (
      await b.call("/api/learning/reviews/" + review.id, {
        method: "PUT",
        body: { version: review.version, active: false, operationId: newId() },
      })
    ).status,
    404,
  );
  assert.equal(
    (await a.call("/api/learning", { expected: b.user.id })).status,
    409,
  );
  assert.equal((await b.call("/api/export")).data.learning.length, 0);
});
test("A second device explicitly claims the checkpoint; stale writes are rejected and the first device can retain a fork", async () => {
  const current = (await a2.call("/api/learning/rounds/" + round.id)).data
    .round;
  const claim = await a2.call("/api/learning/rounds/" + round.id + "/claim", {
    method: "POST",
    body: { version: current.version, operationId: newId() },
  });
  assert.equal(claim.status, 200);
  assert.equal(claim.data.round.generation, 2);
  const stale = engine(current);
  stale.input(current.words[0].term[1]);
  const rejected = await save(a, current, stale, 2);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.data.code, "ROUND_TAKEN_OVER");
  const fork = await a.call("/api/learning/rounds/" + round.id + "/fork", {
    method: "POST",
    body: { operationId: newId(), checkpoint: stale.snapshot() },
  });
  assert.equal(fork.status, 200);
  assert.equal(fork.data.round.kind, "extra");
  assert.equal(fork.data.round.checkpoint.current.typed, 2);
  round = await finish(a2, claim.data.round);
  assert.equal((await a.call("/api/sessions")).data.sessions.length, 1);
  assert.equal((await a.call("/api/learning")).data.summary.plans[0].seen, 2);
});
test("Whole-deck learning advances 30/30/5 without repeating entries, and completed records export and sync", async () => {
  const ids = [];
  for (const size of [30, 30, 5]) {
    const r = await start(a, "builtin-learning");
    assert.equal(r.words.length, size);
    ids.push(...r.words.map((w) => w.source.wordId));
    await finish(a, r);
  }
  assert.equal(new Set(ids).size, 65);
  const plan = (await a2.call("/api/learning")).data.summary.plans.find(
    (p) => p.id === "builtin-learning",
  );
  assert.equal(plan.seen, 65);
  assert.equal(plan.cycle, 1);
  const exported = (await a2.call("/api/export")).data;
  assert.equal(exported.sessions.length, 4);
  assert.ok(exported.learning.some((d) => d.kind === "plan"));
  assert.ok(exported.learning.some((d) => d.kind === "round"));
  const next = await start(a2, "builtin-learning");
  assert.equal(next.cycle, 2);
});
test("Mixed-source review rounds are valid history, two clean attempts archive, manual restore and removal synchronize", async () => {
  const before = (await a.call("/api/learning/reviews")).data.reviews;
  assert.equal(before.length, 1);
  assert.equal(before[0].active, true);
  assert.equal(before[0].cleanStreak, 0);
  const first = await finish(a, await start(a, "review"));
  assert.equal(first.kind, "review");
  assert.equal(
    (await a2.call("/api/learning/reviews")).data.reviews[0].cleanStreak,
    1,
  );
  await finish(a2, await start(a2, "review"));
  let entry = (await a.call("/api/learning/reviews")).data.reviews[0];
  assert.equal(entry.active, false);
  assert.equal(entry.cleanStreak, 2);
  let changed = await a.call("/api/learning/reviews/" + entry.id, {
    method: "PUT",
    body: { version: entry.version, active: true, operationId: newId() },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.review.active, true);
  entry = (await a2.call("/api/learning/reviews")).data.reviews[0];
  changed = await a2.call("/api/learning/reviews/" + entry.id, {
    method: "PUT",
    body: { version: entry.version, active: false, operationId: newId() },
  });
  assert.equal(changed.data.review.active, false);
  assert.equal((await a.call("/api/sessions")).data.sessions.length, 6);
  assert.equal((await b.call("/api/sessions")).data.sessions.length, 0);
});
test("Malformed checkpoints roll back all affected state and restart/backup preserve plans, unfinished rounds and reviews", async () => {
  const r = await start(a, privateDeck.id),
    before = (await a.call("/api/learning")).data.summary;
  const invalid = {
    ...r.checkpoint,
    results: [{ id: "item_99", status: "completed", typed: 1, mistakes: 0 }],
    completedAt: new Date().toISOString(),
  };
  const rejected = await a.call(
    "/api/learning/rounds/" + r.id + "/checkpoint",
    {
      method: "POST",
      body: { generation: r.generation, sequence: 1, checkpoint: invalid },
    },
  );
  assert.equal(rejected.status, 400);
  assert.deepEqual((await a.call("/api/learning")).data.summary, before);
  const backupFile = path.join(directory, "learning-backup.sqlite");
  await backup(app.db, backupFile);
  const db = new DatabaseSync(backupFile, { readOnly: true });
  assert.ok(
    db.prepare("SELECT count(*) n FROM learning_documents").get().n > 0,
  );
  assert.equal(
    db.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  db.close();
  await app.close();
  await launch();
  assert.deepEqual((await a2.call("/api/learning")).data.summary, before);
  assert.equal((await a2.call("/api/sessions")).data.sessions.length, 6);
});

test("System libraries require login, remain shared by every account, and keep learning progress isolated", async () => {
  const guest = device();
  assert.equal((await guest.call("/api/catalog")).status, 401);
  const catalog = (await a.call("/api/catalog")).data.decks;
  assert.ok(catalog.length);
  assert.deepEqual((await a.call("/api/catalog")).data.decks, catalog);
  assert.deepEqual((await b.call("/api/catalog")).data.decks, catalog);
  for (const bank of catalog) {
    assert.equal(bank.builtin, true);
    assert.equal((await guest.call("/api/decks/" + bank.id)).status, 401);
    assert.deepEqual(
      (await a.call("/api/decks/" + bank.id)).data.deck,
      (await b.call("/api/decks/" + bank.id)).data.deck,
    );
  }
  assert.equal(
    catalog.some((d) => d.id === privateDeck.id),
    false,
  );
  assert.equal((await b.call("/api/learning")).data.summary.plans.length, 0);
  assert.ok((await a.call("/api/learning")).data.summary.plans.length > 0);
});

test("A mid-transaction storage failure rolls back checkpoint, coverage and review changes together", async () => {
  const r = await start(a, privateDeck.id),
    p = engine(r);
  p.input("z");
  for (const w of r.words) for (const ch of targetFor(w.term)) p.input(ch);
  const previous = app.store.learning.export(a.user.id);
  app.db.exec(
    "CREATE TRIGGER learning_write_failure BEFORE INSERT ON learning_documents WHEN NEW.kind='round' BEGIN SELECT RAISE(ABORT,'simulated checkpoint failure'); END;",
  );
  try {
    const failed = await save(a, r, p);
    assert.equal(failed.status, 500);
    assert.deepEqual(app.store.learning.export(a.user.id), previous);
  } finally {
    app.db.exec("DROP TRIGGER learning_write_failure");
  }
  assert.equal((await save(a, r, p)).status, 200);
});
