import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import Papa from "papaparse";
import { validateDeck, targetFor } from "../shared/words.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const revision = "ab22ad36302cafc6349a050e2b60894855208055";
const release = "ecdict-2026-10-24.1";
const committedAt = "2026-10-24T09:15:06Z";
const repository = "https://github.com/skywind3000/ECDICT";
const overrides = JSON.parse(
  fs.readFileSync(path.join(root, "seed/meaning-overrides.json"), "utf8"),
);
const glosses = new Map(),
  usedOverrides = new Set();
let omittedDomainLines = 0;
function meaningFor(row) {
  if (glosses.has(row.word)) return glosses.get(row.word);
  const original = row.translation
    .replaceAll("\\r\\n", "\n")
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\n")
    .replace(/\r\n?/g, "\n");
  const lines = original
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const common = lines.filter(
    (line) =>
      !/^(?:(?:n|v|vt|vi|a|adj|adv|prep|conj|pron|art|aux)\.\s*)?\[[^\]]{1,12}\]/i.test(
        line,
      ),
  );
  let meaning = (common.length ? common : lines).join("\n");
  if (common.length) omittedDomainLines += lines.length - common.length;
  if (Object.hasOwn(overrides, row.word)) {
    meaning = overrides[row.word];
    usedOverrides.add(row.word);
  }
  glosses.set(row.word, meaning);
  return meaning;
}
const cache = path.join(root, ".cache", "ecdict", revision);
const definitions = [
  {
    key: "freq3000",
    title: "英语高频 3000",
    count: 3000,
    description: "按来源词频排序的前 3000 词，适合日常基础练习。",
  },
  {
    key: "freq5000",
    title: "英语高频 5000",
    count: 5000,
    description: "按来源词频排序的前 5000 词，扩展阅读与日常词汇。",
  },
  {
    key: "zk",
    title: "中考英语",
    count: 1603,
    description: "按 ECDICT 中考标签全量收录，含中文释义。",
  },
  {
    key: "gk",
    title: "高考英语",
    count: 3677,
    description: "按 ECDICT 高考标签全量收录，含中文释义。",
  },
  {
    key: "cet4",
    title: "大学英语四级 CET-4",
    count: 3849,
    description: "按 ECDICT 四级标签全量收录，含中文释义。",
  },
  {
    key: "cet6",
    title: "大学英语六级 CET-6",
    count: 5407,
    description: "按 ECDICT 六级标签全量收录，含中文释义。",
  },
  {
    key: "ky",
    title: "考研英语",
    count: 4801,
    description: "按 ECDICT 考研标签全量收录，含中文释义。",
  },
  {
    key: "ielts",
    title: "雅思 IELTS",
    count: 5040,
    description: "按 ECDICT 雅思标签全量收录，含中文释义。",
  },
  {
    key: "toefl",
    title: "托福 TOEFL",
    count: 6974,
    description: "按 ECDICT 托福标签全量收录，含中文释义。",
  },
  {
    key: "gre",
    title: "GRE 词汇",
    count: 7504,
    description: "按 ECDICT GRE 标签全量收录，含中文释义。",
  },
];

async function cachedFile(name) {
  const file = path.join(cache, name);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(cache, { recursive: true });
  const response = await fetch(
    `https://raw.githubusercontent.com/skywind3000/ECDICT/${revision}/${name}`,
  );
  if (!response.ok)
    throw new Error(`下载 ${name} 失败：HTTP ${response.status}`);
  const temporary = file + `.part-${process.pid}`;
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      fs.createWriteStream(temporary, { flags: "wx" }),
    );
    fs.renameSync(temporary, file);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
  return file;
}

const csvFile = await cachedFile("ecdict.csv");
const license = fs.readFileSync(await cachedFile("LICENSE"), "utf8");
if (
  !license.startsWith("MIT License") ||
  !license.includes("Copyright (c) 2025 Linwei")
)
  throw new Error("来源授权说明与固定版本不一致");
const tags = definitions.filter((d) => !d.key.startsWith("freq"));
const tagged = new Map(tags.map((d) => [d.key, []]));
const frequency = [];
let rowCount = 0;
await new Promise((resolve, reject) => {
  Papa.parse(fs.createReadStream(csvFile, { encoding: "utf8" }), {
    header: true,
    skipEmptyLines: true,
    step(result, parser) {
      if (result.errors.length) {
        parser.abort();
        reject(
          new Error(
            `源 CSV 第 ${rowCount + 2} 行：${result.errors[0].message}`,
          ),
        );
        return;
      }
      const row = result.data;
      rowCount++;
      const terms = (row.tag || "").split(/\s+/),
        rank = Number(row.frq);
      for (const { key } of tags)
        if (terms.includes(key)) tagged.get(key).push(row);
      if (Number.isInteger(rank) && rank > 0) frequency.push(row);
    },
    complete: resolve,
    error: reject,
  });
});
if (rowCount !== 770611)
  throw new Error(`源数据不完整：预期 770611 行，实际 ${rowCount}`);
frequency.sort(
  (a, b) =>
    Number(a.frq) - Number(b.frq) ||
    (a.word < b.word ? -1 : a.word > b.word ? 1 : 0),
);
const decks = definitions.map((definition, index) => {
  const rows = definition.key.startsWith("freq")
    ? frequency.slice(0, definition.count)
    : tagged.get(definition.key);
  if (rows.length !== definition.count)
    throw new Error(
      `${definition.title} 来源数量不一致：${rows.length} / ${definition.count}`,
    );
  const source = {
    name: "ECDICT",
    url: `${repository}/tree/${revision}`,
    license: "MIT",
    notice: license.trim(),
    revision,
    committedAt,
    selection:
      (definition.key.startsWith("freq")
        ? `frq 为正整数，按词频序号升序取前 ${definition.count} 条`
        : `tag 包含独立标签 ${definition.key}，全量收录`) +
      "；中文释义保留通用义项，少量基础词经过人工校订",
  };
  const words = rows.map((row) => {
    if (!/[\u3400-\u9fff]/.test(row.translation || ""))
      throw new Error(`${row.word} 缺少中文释义`);
    return {
      id:
        "ecdict_" +
        Buffer.from(row.word.normalize("NFC")).toString("base64url"),
      term: row.word,
      meaning: meaningFor(row),
    };
  });
  const deck = validateDeck({ ...definition, words, source });
  const originalTerms = rows.map((r) => r.word);
  if (deck.words.some((w, i) => w.term !== originalTerms[i]))
    throw new Error(
      `${definition.title} 的单词在规范化时发生改变，请显式检查来源`,
    );
  return { id: "builtin-ecdict-" + definition.key, ...deck };
});
const retiredDeckIds = [
  "builtin-basic",
  "builtin-mid",
  "builtin-hard",
  ...Array.from({ length: 11 }, (_, i) => "builtin-topic-" + i),
];
const missingOverrides = Object.keys(overrides).filter(
  (term) => !usedOverrides.has(term),
);
if (missingOverrides.length)
  throw new Error(`释义校订未命中收录范围：${missingOverrides.join(", ")}`);
const manifest = {
  format: "keyword-catalog",
  version: 1,
  release,
  source: {
    name: "ECDICT",
    repository,
    revision,
    committedAt,
    sourceRows: rowCount,
    license: "MIT",
    licenseFile: "licenses/ECDICT-MIT.txt",
  },
  retiredDeckIds,
  decks: decks.map((d, position) => ({
    id: d.id,
    title: d.title,
    wordCount: d.words.length,
    position,
  })),
  totalEntries: decks.reduce((n, d) => n + d.words.length, 0),
  distinctTargets: new Set(
    decks.flatMap((d) => d.words.map((w) => targetFor(w.term))),
  ).size,
  glossary: {
    policy:
      "保留通用释义；有通用义项时省去单独的专业领域释义行；仅有专业义项时完整保留",
    overridesFile: "seed/meaning-overrides.json",
    overriddenTerms: [...usedOverrides].sort(),
    omittedDomainLines,
  },
};
// One word per line keeps the generated catalog inspectable without bloating it.
const output =
  "[\n" +
  decks
    .map(({ words, ...metadata }) => {
      const head = JSON.stringify(metadata, null, 2).slice(0, -2);
      return (
        head +
        ',\n  "words": [\n' +
        words.map((w) => "    " + JSON.stringify(w)).join(",\n") +
        "\n  ]\n}"
      )
        .split("\n")
        .map((line) => "  " + line)
        .join("\n");
    })
    .join(",\n") +
  "\n]\n";
fs.mkdirSync(path.join(root, "licenses"), { recursive: true });
fs.writeFileSync(path.join(root, "licenses/ECDICT-MIT.txt"), license);
fs.writeFileSync(path.join(root, "seed/decks.json"), output);
fs.writeFileSync(
  path.join(root, "seed/catalog.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  `已生成 ${decks.length} 本词库，${manifest.totalEntries} 条收录，${manifest.distinctTargets} 个不同练习目标。`,
);
for (const d of decks) console.log(`${d.title}: ${d.words.length}`);
