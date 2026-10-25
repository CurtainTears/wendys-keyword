import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, openDatabase } from "../server/store.mjs";
import {
  validateDeck,
  validateSource,
  parseImport,
  exportCSV,
  exportTXT,
  makeBackup,
  targetFor,
} from "../shared/words.mjs";
import { createPractice } from "../src/practice.mjs";

const root = new URL("../", import.meta.url);
const packaged = JSON.parse(
  fs.readFileSync(new URL("seed/decks.json", root), "utf8"),
);
const manifest = JSON.parse(
  fs.readFileSync(new URL("seed/catalog.json", root), "utf8"),
);
const simple = (id, term = "old", meaning = "原始释义") => ({
  id,
  title: id,
  description: "",
  words: [{ id: "w-" + term, term, meaning }],
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "keyword-catalog-"));
  const seedFile = path.join(directory, "decks.json"),
    catalogFile = path.join(directory, "catalog.json"),
    legacyFile = path.join(directory, "leaderboard.json");
  fs.writeFileSync(legacyFile, "{}");
  const db = openDatabase(directory);
  db.exec(
    "CREATE TABLE user (id TEXT PRIMARY KEY); INSERT INTO user VALUES ('learner');",
  );
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const write = (release, decks, retiredDeckIds = []) => {
    fs.writeFileSync(seedFile, JSON.stringify(decks));
    fs.writeFileSync(
      catalogFile,
      JSON.stringify({
        format: "keyword-catalog",
        version: 1,
        release,
        retiredDeckIds,
        decks: decks.map((d, position) => ({
          id: d.id,
          wordCount: d.words.length,
          position,
        })),
      }),
    );
  };
  return {
    db,
    write,
    open: () => new Store(db, { seedFile, catalogFile, legacyFile }),
    seedFile,
    catalogFile,
  };
}

test("Packaged catalog contains all ten declared cohorts, usable translations and retained authorization", () => {
  const counts = [3000, 5000, 1603, 3677, 3849, 5407, 4801, 5040, 6974, 7504];
  assert.equal(packaged.length, 10);
  assert.equal(manifest.retiredDeckIds.length, 14);
  const targets = new Set();
  packaged.forEach((d, i) => {
    assert.equal(d.words.length, counts[i]);
    assert.equal(manifest.decks[i].wordCount, counts[i]);
    assert.ok(!manifest.retiredDeckIds.includes(d.id));
    assert.equal(validateDeck(d).words.length, counts[i]);
    assert.equal(new Set(d.words.map((w) => w.id)).size, counts[i]);
    assert.equal(d.source.revision, manifest.source.revision);
    assert.equal(d.source.license, "MIT");
    assert.match(d.source.notice, /Copyright \(c\) 2025 Linwei/);
    for (const w of d.words) {
      assert.match(w.meaning, /[\u3400-\u9fff]/);
      assert.doesNotMatch(w.meaning, /\\r|\\n/);
      targets.add(targetFor(w.term));
    }
  });
  assert.equal(
    packaged.reduce((n, d) => n + d.words.length, 0),
    46855,
  );
  assert.equal(targets.size, 15283);
  assert.equal(manifest.distinctTargets, targets.size);
  const core = packaged[0].words;
  assert.match(core.find((w) => w.term === "a").meaning, /一个/);
  assert.doesNotMatch(
    core.find((w) => w.term === "be").meaning,
    /后端|总线允许/,
  );
});

test("Source notices survive JSON, CSV and TXT exports and re-imports", () => {
  const d = { ...packaged[0], words: packaged[0].words.slice(0, 3) };
  for (const [content, filename] of [
    [JSON.stringify(makeBackup([d])), "words.json"],
    [exportCSV([d]), "words.csv"],
    [exportTXT([d]), "words.txt"],
  ]) {
    const parsed = parseImport(content, { filename });
    assert.equal(
      parsed.issues.filter((x) => x.level === "error").length,
      0,
      filename,
    );
    assert.deepEqual(parsed.decks[0].source, d.source);
    assert.equal(parsed.decks[0].words.length, 3);
  }
  assert.throws(() =>
    validateSource({ ...d.source, url: "javascript:alert(1)" }),
  );
});

test("The complete GRE bank can be imported and sampled without truncation or an obsolete 5000-word limit", () => {
  const d = packaged.find((d) => d.id === "builtin-ecdict-gre");
  const parsed = parseImport(JSON.stringify(makeBackup([d])), {
    filename: "GRE.json",
  });
  assert.equal(parsed.issues.filter((x) => x.level === "error").length, 0);
  assert.equal(parsed.decks[0].words.length, 7504);
  assert.equal(validateDeck(parsed.decks[0]).words.length, 7504);
  const p = createPractice();
  p.start({ ...d, version: 1 });
  assert.equal(p.state.poolLen, 30);
  assert.equal(new Set(p.state.pool.map((w) => targetFor(w.term))).size, 30);
});

test("Existing databases receive new books and retire only specified public examples; private copies and historical results survive", (t) => {
  const f = fixture(t);
  const old = simple("builtin-basic");
  f.write("examples-v1", [old]);
  let store = f.open();
  const privateDeck = store.transaction(() =>
    store.insert(
      "learner",
      {
        title: "我的私人副本",
        description: "保留",
        words: [{ id: "personal", term: "mine", meaning: "我的" }],
      },
      "builtin-personal-existing",
    ),
  );
  const result = {
    id: "round-old",
    deckId: old.id,
    deckVersion: 1,
    durationMs: 1000,
    keystrokes: 4,
    correct: 3,
    wordsDone: 1,
    skipped: 0,
    best: 3,
    words: [{ id: "w-old", status: "completed", mistakes: 1 }],
  };
  store.saveSession("learner", result);
  const before = store.sessions("learner");
  f.write(
    "real-v2",
    [simple("builtin-real", "comet", "彗星")],
    [old.id, privateDeck.id],
  );
  store = f.open();
  assert.deepEqual(
    store.list(null).map((d) => d.id),
    ["builtin-real"],
  );
  assert.throws(
    () => store.get(old.id, null),
    (error) => error.status === 404,
  );
  assert.deepEqual(
    store.get(privateDeck.id, "learner").words,
    privateDeck.words,
  );
  assert.deepEqual(store.sessions("learner"), before);
  assert.equal(
    store.get(old.id, null, { includeDeleted: true }).words[0].meaning,
    "原始释义",
  );
  assert.equal(
    store.saveSession("learner", { ...result, id: "in-flight" }).words[0]
      .meaning,
    "原始释义",
  );
});

test("Repeated catalog initialization is idempotent and updated books retain their old snapshots", (t) => {
  const f = fixture(t),
    id = "builtin-real";
  f.write("v1", [simple(id, "bank", "银行")]);
  let store = f.open();
  const original = store.get(id, null);
  store = f.open();
  assert.equal(store.get(id, null).version, 1);
  f.write("v2", [simple(id, "bank", "银行；河岸")]);
  store = f.open();
  assert.equal(store.get(id, null).version, 2);
  assert.equal(
    JSON.parse(
      f.db
        .prepare(
          "SELECT snapshot FROM deck_revisions WHERE deck_id=? AND version=1",
        )
        .get(id).snapshot,
    ).words[0].meaning,
    "银行",
  );
  assert.equal(store.get(id, null).words[0].id, original.words[0].id);
  store = f.open();
  assert.equal(store.get(id, null).version, 2);
});

test("Invalid or failed catalog updates roll back the entire release and cannot overwrite a private ID", (t) => {
  const f = fixture(t),
    old = simple("builtin-basic");
  f.write("v1", [old]);
  let store = f.open();
  f.db.exec(
    "CREATE TRIGGER reject_catalog BEFORE INSERT ON words WHEN NEW.term='explode' BEGIN SELECT RAISE(ABORT,'simulated catalog failure'); END;",
  );
  f.write(
    "v2",
    [simple("builtin-one", "comet"), simple("builtin-two", "explode")],
    [old.id],
  );
  assert.throws(() => f.open(), /simulated catalog failure/);
  assert.deepEqual(
    store.list(null).map((d) => d.id),
    [old.id],
  );
  assert.equal(
    f.db.prepare("SELECT value FROM app_meta WHERE key='catalog-release'").get()
      .value,
    "v1",
  );
  f.db.exec("DROP TRIGGER reject_catalog");
  store.transaction(() =>
    store.insert(
      "learner",
      validateDeck({
        title: "私人",
        words: [{ term: "private", meaning: "私人" }],
      }),
      "builtin-conflict",
    ),
  );
  f.write("v3", [simple("builtin-conflict", "new")], [old.id]);
  assert.throws(() => f.open(), /私人词库标识冲突/);
  assert.equal(
    store.get("builtin-conflict", "learner").words[0].term,
    "private",
  );
  assert.equal(store.get(old.id, null).version, 1);
  const bad = JSON.parse(fs.readFileSync(f.catalogFile));
  bad.decks[0].wordCount = 99;
  fs.writeFileSync(f.catalogFile, JSON.stringify(bad));
  assert.throws(() => f.open(), /清单不一致/);
});
