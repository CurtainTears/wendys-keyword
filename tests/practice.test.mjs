import { test } from "node:test";
import assert from "node:assert/strict";
import { createPractice } from "../src/practice.mjs";
import { targetFor } from "../shared/words.mjs";
const deck = (id, words) => ({
  id,
  version: 1,
  title: id,
  words: words.map((term, i) => ({ id: "w" + i, term, meaning: "释义" + i })),
});
test("New deck always gets a fresh pool and clean statistics; no repeated entries", () => {
  const p = createPractice({ random: () => 0.99 });
  p.start(deck("a", ["old", "older"]));
  p.input("x");
  p.input("o");
  p.start(deck("b", ["GPT-4", "résumé"]));
  assert.equal(p.state.word, "gpt-4");
  assert.equal(p.state.keystrokes, 0);
  assert.equal(p.state.correct, 0);
  assert.equal(p.state.wordsDone, 0);
  assert.equal(Object.keys(p.state.wrong).length, 0);
  for (const w of ["GPT-4", "résumé"])
    for (const ch of targetFor(w)) p.input(ch);
  assert.equal(p.state.done, true);
  assert.deepEqual(
    p.result().words.map((w) => w.term),
    ["GPT-4", "résumé"],
  );
  assert.equal(new Set(p.result().words.map((w) => w.id)).size, 2);
});
test("Timer starts with first input and fully excludes pause, including zero time", () => {
  let time = 0;
  const p = createPractice({ clock: () => time, random: () => 0.99 });
  p.start(deck("a", ["abc"]));
  time = 50000;
  assert.equal(p.elapsed(), 0);
  p.input("a");
  time = 51000;
  p.pause();
  time = 61000;
  assert.equal(p.input("b").kind, "ignored");
  assert.equal(p.elapsed(), 1000);
  p.resume();
  time = 62000;
  p.input("b");
  p.input("c");
  time = 99999;
  assert.equal(p.elapsed(), 2000);
  assert.equal(p.result().durationMs, 2000);
  const zero = createPractice({ clock: () => 0 });
  zero.start(deck("z", ["a"]));
  zero.input("a");
  assert.equal(zero.result().durationMs, 0);
});
test("Skip is not a completed word and wrong book keeps the exact sense", () => {
  const p = createPractice({ random: () => 0.99 });
  const d = deck("a", ["bank", "river bank"]);
  d.words[1].meaning = "河岸";
  p.start(d);
  p.skip();
  p.input("x");
  for (const ch of "river bank") p.input(ch);
  assert.equal(p.state.wordsDone, 1);
  assert.equal(p.state.skipped, 1);
  assert.equal(p.result().words[1].meaning, "河岸");
  assert.equal(Object.keys(p.state.wrong).length, 2);
  assert.equal(p.result().words[0].status, "skipped");
});
test("Different senses are retained in the library but a typing target appears only once per round", () => {
  const p = createPractice({ random: () => 0.99 });
  p.start(deck("a", ["bank", "BANK", "bank", "comet"]));
  assert.equal(p.state.poolLen, 2);
  assert.equal(new Set(p.state.pool.map((w) => targetFor(w.term))).size, 2);
});
test("A round caps at 30 distinct entries, ends only once and rejects input after finish", () => {
  const p = createPractice();
  p.start(
    deck(
      "a",
      Array.from({ length: 80 }, (_, i) => "word" + i),
    ),
  );
  assert.equal(p.state.poolLen, 30);
  for (let i = 0; i < 30; i++) p.skip();
  assert.equal(p.state.done, true);
  assert.equal(p.skip().kind, "ignored");
  assert.equal(p.input("a").kind, "ignored");
  assert.equal(p.result().words.length, 30);
});
test("Practice snapshot survives concurrent edits without mixing versions or meanings", () => {
  const d = deck("a", ["abc"]);
  const p = createPractice();
  p.start(d);
  d.title = "changed";
  d.version = 2;
  d.words[0].meaning = "改过的释义";
  for (const ch of "abc") p.input(ch);
  assert.equal(p.result().title, "a");
  assert.equal(p.result().deckVersion, 1);
  assert.equal(p.result().words[0].meaning, "释义0");
});

test("Prototype-looking word IDs cannot break wrong-book recording", () => {
  const p = createPractice({ random: () => 0.99 });
  const d = deck("a", ["abc", "xyz"]);
  d.words[0].id = "__proto__";
  d.words[1].id = "constructor";
  p.start(d);
  p.input("x");
  for (const ch of "abc") p.input(ch);
  p.input("a");
  for (const ch of "xyz") p.input(ch);
  assert.equal(p.state.done, true);
  assert.equal(Object.keys(p.state.wrong).length, 2);
  assert.equal(p.state.wrong["__proto__"].term, "abc");
});
