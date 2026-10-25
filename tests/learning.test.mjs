import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, openDatabase } from "../server/store.mjs";
import assert from "node:assert/strict";
import {
  LearningModel,
  MemoryLearningRepo,
  lexemeKey,
} from "../shared/learning.mjs";
import { createPractice } from "../src/practice.mjs";
import { newId, targetFor } from "../shared/words.mjs";

function fixture(
  words = Array.from({ length: 65 }, (_, i) => ({
    id: "w" + i,
    term: "word" + i,
    meaning: "释义" + i,
  })),
) {
  const repo = new MemoryLearningRepo(),
    decks = new Map(),
    revisions = new Map();
  let time = Date.parse("2026-01-01T00:00:00Z");
  const now = () => new Date((time += 1000)).toISOString();
  const add = (id, words, version = 1) => {
    const deck = { id, title: id, version, words };
    decks.set(id, deck);
    revisions.set(id + "@" + version, structuredClone(deck));
    return deck;
  };
  add("deck", words);
  const model = new LearningModel(repo, {
    random: () => 0.99,
    now,
    getDeck: (id, version) => {
      const value = version ? revisions.get(id + "@" + version) : decks.get(id);
      if (!value) throw new Error("missing deck");
      return value;
    },
  });
  const engine = (round) => {
    const p = createPractice({ clock: () => 0, now });
    p.start(
      {
        id: round.scopeId,
        title: round.title,
        version: round.deckVersion,
        words: round.words,
      },
      { ordered: true, id: round.id },
    );
    return p;
  };
  const start = (deckId = "deck", restart = false) =>
    model.start({ deckId, restart, operationId: newId() });
  const save = (round, p, sequence = 1) =>
    model.checkpoint(round.id, {
      generation: round.generation,
      sequence,
      checkpoint: p.snapshot(),
    });
  const finish = (round, { wrong = false, skip = false } = {}) => {
    const p = engine(round);
    for (const w of round.words) {
      if (wrong) p.input("~");
      if (wrong) p.input(w.term[0] === "x" ? "z" : "x");
      if (skip) p.skip();
      else for (const c of targetFor(w.term)) p.input(c);
    }
    return save(round, p);
  };
  return { repo, model, decks, add, now, engine, start, save, finish };
}
test("Whole-deck batches visit every entry once before the next cycle; skips are visited but not completions", () => {
  const f = fixture(),
    seen = [];
  for (const size of [30, 30, 5]) {
    const r = f.start();
    assert.equal(r.words.length, size);
    seen.push(...r.words.map((w) => w.source.wordId));
    f.finish(r, { skip: true });
  }
  assert.equal(new Set(seen).size, 65);
  assert.deepEqual(f.model.summary().plans[0], {
    id: "deck",
    title: "deck",
    deckVersion: 1,
    cycle: 1,
    seen: 65,
    skipped: 65,
    total: 65,
  });
  const next = f.start();
  assert.equal(next.cycle, 2);
  assert.equal(f.model.summary().plans[0].seen, 0);
});
test("Different meanings with the same spelling are postponed, not discarded from whole-deck coverage", () => {
  const f = fixture([
    { id: "one", term: "bank", meaning: "银行" },
    { id: "two", term: "BANK", meaning: "河岸" },
    { id: "three", term: "sun", meaning: "太阳" },
  ]);
  const first = f.start();
  assert.equal(first.words.length, 2);
  f.finish(first);
  const second = f.start();
  assert.equal(second.words.length, 1);
  assert.equal(second.words[0].meaning, "河岸");
  f.finish(second);
  assert.equal(f.model.summary().plans[0].seen, 3);
});
test("An unfinished snapshot restores exact typed position, metrics and wrong words without charging closed-page time", () => {
  let time = 0;
  const f = fixture([
      { id: "one", term: "sun", meaning: "太阳" },
      { id: "two", term: "moon", meaning: "月亮" },
    ]),
    r = f.start();
  const p = createPractice({ clock: () => time, now: f.now });
  p.start(
    { id: "deck", title: "deck", version: 1, words: r.words },
    { ordered: true, id: r.id },
  );
  p.input("x");
  time = 500;
  p.input("s");
  p.input("u");
  const saved = f.save(r, p);
  assert.equal(saved.checkpoint.current.typed, 2);
  const restored = createPractice({ clock: () => time, now: f.now });
  time = 900000;
  restored.restore(
    { id: "deck", title: "deck", version: 1, words: r.words },
    saved.checkpoint,
    r.id,
  );
  assert.equal(restored.state.typed, 2);
  assert.equal(restored.state.wrong.item_0.n, 1);
  assert.equal(restored.metrics().duration, 500);
  restored.pause();
  restored.resume();
  time += 900000;
  assert.equal(restored.metrics().duration, 500);
  restored.input("n");
  time += 100;
  for (const ch of "moon") restored.input(ch);
  assert.equal(restored.state.done, true);
  assert.equal(restored.metrics().duration, 600);
  assert.equal(restored.state.keystrokes, 8);
  assert.equal(f.save(saved, restored, 2).status, "done");
});
test("Claim generations prevent a stale device from overwriting progress and can fork its retained local round", () => {
  const f = fixture(),
    r = f.start(),
    p = f.engine(r);
  p.input("w");
  const v = f.save(r, p);
  const op = { operationId: newId(), version: v.version };
  const claimed = f.model.claim(r.id, op);
  assert.equal(claimed.generation, 2);
  assert.equal(claimed.checkpoint.current.typed, 1);
  p.input("o");
  assert.throws(
    () => f.save(r, p, 2),
    (e) => e.code === "ROUND_TAKEN_OVER",
  );
  const replay = f.model.claim(r.id, op);
  assert.equal(replay.generation, 2);
  f.model.claim(r.id, { operationId: newId(), version: claimed.version });
  assert.equal(f.model.claim(r.id, op).generation, 2); // Lost response replays the original claim, not the latest writer's generation.
  const fork = f.model.fork(r.id, {
    operationId: newId(),
    checkpoint: p.snapshot(),
  });
  assert.equal(fork.kind, "extra");
  assert.equal(fork.checkpoint.current.typed, 2);
  assert.equal(f.model.round(r.id).generation, 3);
});
test("Checkpoint retries are idempotent; corrupt positions, counters, reordering and rewinds are rejected", () => {
  const f = fixture(),
    r = f.start(),
    p = f.engine(r);
  p.input("w");
  const first = f.save(r, p);
  assert.deepEqual(f.save(r, p), first);
  assert.throws(
    () =>
      f.model.checkpoint(r.id, {
        generation: 1,
        sequence: 2,
        checkpoint: { ...p.snapshot(), correct: 100 },
      }),
    /统计/,
  );
  assert.throws(
    () =>
      f.model.checkpoint(r.id, {
        generation: 1,
        sequence: 2,
        checkpoint: { ...p.snapshot(), current: { typed: 99, mistakes: 0 } },
      }),
    /位置/,
  );
  p.input("o");
  f.save(r, p, 2);
  assert.throws(
    () =>
      f.model.checkpoint(r.id, {
        generation: 1,
        sequence: 3,
        checkpoint: first.checkpoint,
      }),
    (e) => e.status === 409,
  );
  assert.equal(f.model.round(r.id).checkpoint.current.typed, 2);
});
test("Partial mistakes enter the review list immediately; correcting the same attempt does not count as clean", () => {
  const f = fixture([{ id: "one", term: "sun", meaning: "太阳" }]),
    r = f.start(),
    p = f.engine(r);
  p.input("x");
  f.save(r, p);
  assert.equal(f.model.reviews()[0].active, true);
  assert.equal(f.model.reviews()[0].wrongRounds, 1);
  p.input("y");
  f.save(r, p, 2);
  assert.equal(f.model.reviews()[0].wrongRounds, 1);
  for (const c of "sun") p.input(c);
  f.save(r, p, 3);
  assert.equal(f.model.reviews()[0].active, true);
  assert.equal(f.model.reviews()[0].cleanStreak, 0);
});
test("Two independent clean reviews archive a word; later errors bring it back without deleting history", () => {
  const f = fixture([{ id: "one", term: "sun", meaning: "太阳" }]);
  f.finish(f.start(), { wrong: true });
  let r = f.start("review");
  f.finish(r);
  let entry = f.model.reviews()[0];
  assert.equal(entry.cleanStreak, 1);
  assert.equal(entry.active, true);
  f.finish(f.start("review"));
  entry = f.model.reviews()[0];
  assert.equal(entry.cleanStreak, 2);
  assert.equal(entry.active, false);
  assert.equal(f.model.sessions().length, 3);
  f.finish(f.start(), { wrong: true });
  entry = f.model.reviews()[0];
  assert.equal(entry.active, true);
  assert.equal(entry.cleanStreak, 0);
  assert.equal(entry.wrongRounds, 2);
});
test("Cross-deck reviews merge identical senses, retain all source revisions and keep different senses separate", () => {
  const f = fixture([{ id: "a", term: "bank", meaning: "银行" }]);
  f.add("second", [
    { id: "b", term: "BANK", meaning: "银行" },
    { id: "c", term: "bank", meaning: "河岸" },
  ]);
  f.finish(f.start(), { wrong: true });
  f.finish(f.start("second"), { wrong: true });
  f.finish(f.start("second"), { wrong: true });
  const entries = f.model.reviews();
  assert.equal(entries.length, 2);
  const bank = entries.find((e) => e.meaning === "银行");
  assert.equal(bank.sources.length, 2);
  assert.equal(bank.wrongRounds, 2);
  const round = f.start("review");
  assert.equal(round.words.length, 1);
  assert.ok(round.words[0].source.deckId);
  assert.notEqual(
    lexemeKey({ term: "bank", meaning: "银行" }),
    lexemeKey({ term: "bank", meaning: "河岸" }),
  );
});
test("Manual removal and restore are reversible and versioned; replay does not duplicate actions", () => {
  const f = fixture([{ id: "one", term: "sun", meaning: "太阳" }]);
  f.finish(f.start(), { wrong: true });
  let entry = f.model.reviews()[0];
  const payload = {
    version: entry.version,
    active: false,
    operationId: newId(),
  };
  entry = f.model.reviewAction(entry.id, payload);
  assert.equal(entry.active, false);
  assert.equal(entry.reason, "manual");
  assert.deepEqual(f.model.reviewAction(entry.id, payload), entry);
  assert.throws(
    () => f.model.reviewAction(entry.id, { ...payload, operationId: newId() }),
    (e) => e.status === 409,
  );
  entry = f.model.reviewAction(entry.id, {
    version: entry.version,
    active: true,
    operationId: newId(),
  });
  assert.equal(entry.active, true);
  assert.equal(entry.cleanStreak, 0);
});
test("Late offline clean outcomes cannot hide a newer error; repeated imports do not inflate counts", () => {
  const f = fixture(),
    word = { id: "w", term: "sun", meaning: "太阳" },
    record = (id, at, mistakes) => ({
      id,
      deckId: "deck",
      deckVersion: 1,
      title: "deck",
      createdAt: at,
      words: [{ ...word, status: "completed", mistakes }],
    });
  f.model.recordLegacy(record("new-error", "2026-01-05T00:00:00Z", 1));
  f.model.recordLegacy(record("old-clean-a", "2026-01-02T00:00:00Z", 0));
  f.model.recordLegacy(record("old-clean-b", "2026-01-03T00:00:00Z", 0));
  f.model.recordLegacy(record("new-error", "2026-01-05T00:00:00Z", 1));
  assert.equal(f.model.reviews()[0].active, true);
  assert.equal(f.model.reviews()[0].wrongRounds, 1);
  assert.equal(f.model.reviews()[0].cleanStreak, 0);
});
test("Deck edits keep an unfinished snapshot, then reconcile additions, deletions and changed senses for the next batch", () => {
  const f = fixture([
      { id: "a", term: "sun", meaning: "太阳" },
      { id: "b", term: "moon", meaning: "月亮" },
    ]),
    r = f.start(),
    p = f.engine(r);
  for (const c of "sun") p.input(c);
  f.save(r, p);
  f.add(
    "deck",
    [
      { id: "a", term: "sun", meaning: "日光" },
      { id: "c", term: "comet", meaning: "彗星" },
    ],
    2,
  );
  const continued = f.start();
  assert.equal(continued.deckVersion, 1);
  assert.equal(continued.words[1].term, "moon");
  const restored = f.engine(continued);
  restored.restore(
    { id: "deck", version: 1, title: "deck", words: continued.words },
    continued.checkpoint,
    continued.id,
  );
  for (const c of "moon") restored.input(c);
  f.save(continued, restored);
  const next = f.start();
  assert.equal(next.deckVersion, 2);
  assert.deepEqual(
    new Set(next.words.map((w) => w.meaning)),
    new Set(["日光", "彗星"]),
  );
  assert.equal(f.model.sessions()[0].words[0].meaning, "太阳");
});
test("Explicit restart preserves whole-deck coverage and the archived checkpoint", () => {
  const f = fixture(),
    r = f.start(),
    p = f.engine(r);
  for (const c of "word0") p.input(c);
  f.save(r, p);
  const restarted = f.start("deck", true);
  assert.notEqual(restarted.id, r.id);
  assert.equal(f.model.round(r.id).status, "archived");
  assert.equal(f.model.summary().plans[0].seen, 1);
  assert.equal(restarted.words[0].term, r.words[0].term);
});

test("Forking an already observed prefix does not turn one clean attempt into two or erase an error", () => {
  const f = fixture([{ id: "one", term: "sun", meaning: "太阳" }]);
  f.finish(f.start(), { wrong: true });
  const review = f.finish(f.start("review"));
  assert.equal(f.model.reviews()[0].cleanStreak, 1);
  f.model.fork(review.id, {
    operationId: newId(),
    checkpoint: review.checkpoint,
  });
  assert.equal(f.model.reviews()[0].cleanStreak, 1);
  const dirty = f.finish(f.start(), { wrong: true });
  f.model.fork(dirty.id, {
    operationId: newId(),
    checkpoint: dirty.checkpoint,
  });
  assert.equal(f.model.reviews()[0].wrongRounds, 2);
});

test("A version-checked manual removal wins over a known future clock and over finalizing the same dirty attempt", () => {
  const f = fixture([{ id: "one", term: "sun", meaning: "太阳" }]);
  f.model.recordLegacy({
    id: "future",
    deckId: "deck",
    deckVersion: 1,
    title: "deck",
    createdAt: "2099-01-01T00:00:00Z",
    words: [
      {
        id: "one",
        term: "sun",
        meaning: "太阳",
        status: "completed",
        mistakes: 1,
      },
    ],
  });
  let e = f.model.reviews()[0];
  e = f.model.reviewAction(e.id, {
    operationId: newId(),
    version: e.version,
    active: false,
  });
  assert.equal(e.active, false);
  const r = f.start(),
    p = f.engine(r);
  p.input("x");
  f.save(r, p);
  e = f.model.reviews()[0];
  e = f.model.reviewAction(e.id, {
    operationId: newId(),
    version: e.version,
    active: false,
  });
  for (const c of "sun") p.input(c);
  f.save(r, p, 2);
  assert.equal(f.model.reviews()[0].active, false);
});

test("Upgrading an existing database backfills old complete records once and preserves the untouched history", (t) => {
  const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "keyword-learning-migration-"),
    ),
    seedFile = path.join(dir, "seed.json"),
    legacyFile = path.join(dir, "legacy.json");
  fs.writeFileSync(
    seedFile,
    JSON.stringify([
      {
        id: "builtin-old",
        title: "旧词库",
        words: [
          { id: "sun", term: "sun", meaning: "太阳" },
          { id: "moon", term: "moon", meaning: "月亮" },
        ],
      },
    ]),
  );
  fs.writeFileSync(legacyFile, "{}");
  const db = openDatabase(dir);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.exec(
    "CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES ('learner');",
  );
  const store = new Store(db, { seedFile, legacyFile });
  const old = {
    id: "old-round",
    deckId: "builtin-old",
    deckVersion: 1,
    createdAt: "2026-01-01T00:00:00Z",
    durationMs: 1000,
    keystrokes: 4,
    correct: 3,
    wordsDone: 1,
    skipped: 0,
    best: 3,
    words: [{ id: "sun", status: "completed", mistakes: 1 }],
  };
  store.saveLegacySession("learner", old);
  db.exec(
    "DROP TABLE learning_documents; DELETE FROM app_meta WHERE key='learning-v1';",
  );
  const before = db
    .prepare("SELECT result FROM practice_sessions")
    .get().result;
  const upgraded = new Store(db, { seedFile, legacyFile });
  const entry = upgraded.learning.read("learner", "reviews")[0];
  assert.equal(entry.term, "sun");
  assert.equal(entry.wrongRounds, 1);
  const round = upgraded.learning.write("learner", "start", {
    deckId: "builtin-old",
    operationId: newId(),
  });
  assert.equal(round.words.length, 1);
  assert.equal(round.words[0].term, "moon");
  const again = new Store(db, { seedFile, legacyFile });
  assert.equal(
    again.learning.read("learner", "reviews")[0].version,
    entry.version,
  );
  assert.equal(
    db.prepare("SELECT result FROM practice_sessions").get().result,
    before,
  );
});
