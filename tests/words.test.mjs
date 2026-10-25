import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseImport,
  validateDeck,
  exportCSV,
  makeBackup,
  targetFor,
  mergeWords,
} from "../shared/words.mjs";
test("TXT preserves spelling, digits, accents, phrases and distinct senses", () => {
  const p = parseImport(
    '# 旅行\nGPT-4 模型\nrésumé 简历\ndon’t 不要\nC++ 编程语言\n"hello world" 你好\nbank 银行\nbank 河岸\nbank 河岸',
  );
  assert.equal(p.decks.length, 1);
  assert.equal(p.decks[0].words.length, 7);
  assert.equal(p.duplicateCount, 1);
  assert.equal(p.issues.filter((x) => x.level === "error").length, 0);
  assert.deepEqual(
    p.decks[0].words.map((x) => x.term),
    ["GPT-4", "résumé", "don’t", "C++", "hello world", "bank", "bank"],
  );
  assert.equal(targetFor("don’t"), "don't");
});
test("Dictionary metadata is removed without deleting valid spelling", () => {
  const p = parseImport(
    "Wi-Fi　n. 无线网络\nChina Telecom　n. 中国电信\nkey-card entry door = n. /ˈkiː/ 门禁\nquery = v./n. 查询",
  );
  assert.deepEqual(
    p.decks[0].words.map((x) => [x.term, x.meaning]),
    [
      ["Wi-Fi", "无线网络"],
      ["China Telecom", "中国电信"],
      ["key-card entry door", "门禁"],
      ["query", "查询"],
    ],
  );
});
test("CSV handles quoted commas, newlines, BOM, Chinese headers and TSV", () => {
  const p = parseImport(
    '\ufeff"word","meaning","deck"\r\n"hello, world","问候\n含换行","旅行"\r\n"résumé","简历","工作"',
  );
  assert.equal(p.decks.length, 2);
  assert.equal(p.decks[0].words[0].term, "hello, world");
  assert.equal(p.decks[0].words[0].meaning, "问候\n含换行");
  const t = parseImport("英文\t释义\nGPT-4\t模型", { filename: "test.tsv" });
  assert.equal(t.decks[0].words[0].term, "GPT-4");
});
test("CSV and JSON round-trip Unicode and hostile-looking plain text", () => {
  const d = validateDeck({
    title: "自定义",
    words: [
      { term: "résumé", meaning: "<img src=x onerror=alert(1)>" },
      { term: 'quote "test"', meaning: "a,b\n第二行" },
    ],
  });
  for (const [content, filename] of [
    [exportCSV([d]), "test.csv"],
    [JSON.stringify(makeBackup([d])), "test.json"],
  ]) {
    const p = parseImport(content, { filename });
    assert.equal(p.issues.length, 0);
    assert.deepEqual(
      p.decks[0].words.map((w) => [w.term, w.meaning]),
      d.words.map((w) => [w.term, w.meaning]),
    );
  }
});
test("Invalid rows and unsupported backup versions are reported, not silently repaired", () => {
  const p = parseImport("猫 cat\napple 苹果\nhello🙂 笑脸");
  assert.equal(p.issues.filter((x) => x.level === "error").length, 2);
  assert.equal(p.decks[0].words.length, 1);
  assert.equal(
    parseImport("{bad", { filename: "x.json" }).issues[0].level,
    "error",
  );
  assert.equal(
    parseImport('{"format":"keyword-backup","version":999,"decks":[]}', {
      filename: "x.json",
    }).decks.length,
    0,
  );
  assert.throws(() =>
    validateDeck({
      title: "x",
      words: [{ term: "apple", meaning: "x".repeat(1001) }],
    }),
  );
  assert.equal(
    parseImport("[null]", { filename: "x.json" }).issues[0].level,
    "error",
  );
  assert.equal(
    parseImport("a".repeat(3 * 1024 * 1024 + 1)).issues[0].level,
    "error",
  );
});
test("Append deduplicates an exact sense, keeps different meanings", () => {
  const a = validateDeck({
    title: "x",
    words: [{ term: "bank", meaning: "银行" }],
  }).words;
  const b = validateDeck({
    title: "x",
    words: [
      { term: "BANK", meaning: "银行" },
      { term: "bank", meaning: "河岸" },
    ],
  }).words;
  assert.equal(mergeWords(a, b).length, 2);
  assert.match(
    exportCSV([{ title: "x", words: [{ term: "=SUM(A1)", meaning: "=1+1" }] }]),
    /'=1\+1/,
  );
});
