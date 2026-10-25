import Papa from "papaparse";

export const MAX_WORDS = 20000;
export const MAX_DECKS_PER_IMPORT = 30;
const ALLOWED_TERM =
  /^[\p{Script=Latin}\p{M}\p{N} '’‘"“”\-–—.,!?+/#&()%_@:;=]+$/u;

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function newId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const h = Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function targetFor(term) {
  return term
    .normalize("NFC")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .toLowerCase();
}

export function isPracticeChar(ch) {
  return (
    typeof ch === "string" &&
    Array.from(ch).length === 1 &&
    ALLOWED_TERM.test(ch)
  );
}

export function validateWord(word, index = 0) {
  if (!word || typeof word !== "object" || typeof word.term !== "string")
    throw new InputError(`第 ${index + 1} 条缺少英文`);
  const term = word.term
    .normalize("NFC")
    .replace(/[\s\u200b\ufeff]+/g, " ")
    .trim();
  if (
    !term ||
    term.length > 160 ||
    !ALLOWED_TERM.test(term) ||
    !/[\p{L}\p{N}]/u.test(term)
  ) {
    throw new InputError(
      `第 ${index + 1} 条英文无效：限 160 字符，支持拉丁字母、数字和常用标点`,
    );
  }
  if (word.meaning != null && typeof word.meaning !== "string")
    throw new InputError(`第 ${index + 1} 条释义必须是文本`);
  const meaning = (word.meaning || "").trim();
  if (meaning.length > 1000)
    throw new InputError(`第 ${index + 1} 条释义超过 1000 字符`);
  const id = word.id || newId();
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw new InputError("词条标识无效");
  return { id, term, meaning };
}

export function validateSource(source) {
  if (source == null) return undefined;
  if (typeof source !== "object" || Array.isArray(source))
    throw new InputError("词库来源说明格式无效");
  const fields = {
    name: 100,
    url: 1000,
    license: 100,
    notice: 5000,
    revision: 100,
    selection: 500,
    committedAt: 80,
  };
  const result = {};
  for (const [key, limit] of Object.entries(fields)) {
    if (source[key] === undefined) continue;
    if (typeof source[key] !== "string" || source[key].length > limit)
      throw new InputError(`词库来源字段 ${key} 无效`);
    result[key] = source[key].trim();
  }
  if (!result.name || !result.url || !result.license || !result.notice)
    throw new InputError("词库来源需包含名称、链接、许可证及授权说明");
  let url;
  try {
    url = new URL(result.url);
  } catch {
    throw new InputError("词库来源链接无效");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new InputError("词库来源链接必须使用不含登录信息的 HTTPS 地址");
  return result;
}

export function validateDeck(deck) {
  if (!deck || typeof deck !== "object" || typeof deck.title !== "string")
    throw new InputError("请填写词库名称");
  const title = deck.title.trim();
  if (!title || title.length > 80)
    throw new InputError("词库名称需为 1–80 字符");
  if (deck.description != null && typeof deck.description !== "string")
    throw new InputError("词库说明必须是文本");
  const description = (deck.description || "").trim();
  if (description.length > 500) throw new InputError("词库说明最多 500 字符");
  if (!Array.isArray(deck.words) || deck.words.length > MAX_WORDS)
    throw new InputError(`每个词库最多 ${MAX_WORDS} 条词`);
  const words = deck.words.map(validateWord),
    ids = new Set();
  for (const word of words) {
    if (ids.has(word.id)) throw new InputError("词条标识重复，请重新导入");
    ids.add(word.id);
  }
  const source = validateSource(deck.source);
  return { title, description, words, ...(source ? { source } : {}) };
}

function cleanMeaning(text) {
  let value = text.trim(),
    previous;
  do {
    previous = value;
    value = value
      .replace(
        /^[\/,;]?\s*(?:v|n|vt|vi|adj|adv|prep|conj|pron|num|art|int|det|aux|abbr|modal)\.\s*/i,
        "",
      )
      .replace(/^\/[^/]+\/\s*/, "")
      .replace(/^[\s=:：]+/, "")
      .trim();
  } while (value !== previous);
  return value;
}

function splitTextLine(line) {
  const quoted = line.match(/^("(?:[^"\\]|\\.)+")\s*(?:[=:：]\s*)?(.*)$/);
  if (quoted) {
    try {
      return { term: JSON.parse(quoted[1]), meaning: cleanMeaning(quoted[2]) };
    } catch {
      throw new InputError("词组引号或转义格式不正确");
    }
  }
  const explicit = line.match(/^(.+?)\s*(?:\t+|\s*[=:：]\s*)\s*(.+)$/);
  if (explicit)
    return { term: explicit[1], meaning: cleanMeaning(explicit[2]) };
  const cjk = line.search(/[\u3400-\u9fff\u3001-\u303f\uff01-\uff65]/);
  if (cjk < 0) return { term: line, meaning: "" };
  let term = line.slice(0, cjk).trim(),
    meaning = line.slice(cjk);
  // Dictionary metadata precedes the first Chinese character; keep it out of the typing target.
  const metadata = term.match(
    /\s+(?:(?:v|n|vt|vi|adj|adv|prep|conj|pron|num|art|int|det|aux|abbr|modal)\.(?:\/[a-z]+\.)?\s*|\/[^/]*\/\s*)+$/i,
  );
  if (metadata) term = term.slice(0, metadata.index).trim();
  return { term, meaning: cleanMeaning(meaning) };
}

export function parseImport(
  text,
  { format = "auto", filename = "新词库" } = {},
) {
  const content = String(text || "").replace(/^\ufeff/, "");
  if (new TextEncoder().encode(content).byteLength > 3 * 1024 * 1024)
    return {
      decks: [],
      issues: [
        { line: 0, level: "error", message: "内容超过 3 MB，请分批导入" },
      ],
      duplicateCount: 0,
    };
  const title = filename.replace(/\.(txt|csv|tsv|json)$/i, "") || "新词库";
  const issues = [],
    decks = [];
  const seenWords = new WeakMap();
  let duplicateCount = 0;
  const add = (deck, raw, line) => {
    try {
      const word = validateWord({ term: raw.term, meaning: raw.meaning });
      // Different senses remain separate. Only exact target + meaning duplicates are collapsed.
      const seen = seenWords.get(deck);
      const key = `${targetFor(word.term)}\0${word.meaning}`;
      if (seen.has(key)) {
        duplicateCount++;
        issues.push({
          line,
          level: "warning",
          message: `重复词条：${word.term}（保留一条）`,
        });
      } else {
        seen.add(key);
        deck.words.push(word);
      }
    } catch (e) {
      issues.push({ line, level: "error", message: e.message });
    }
  };
  const makeDeck = (name, description = "") => {
    const d = { title: name, description, words: [] };
    seenWords.set(d, new Set());
    decks.push(d);
    return d;
  };
  if (format === "auto") {
    const firstRow = Papa.parse(content, { preview: 1 }).data[0] || [];
    format =
      /\.json$/i.test(filename) || /^[\[{]/.test(content.trim())
        ? "json"
        : /\.(csv|tsv)$/i.test(filename) ||
            firstRow.some((x) =>
              ["word", "term", "英文", "单词"].includes(
                String(x).trim().toLowerCase(),
              ),
            )
          ? "csv"
          : "txt";
  }
  if (format === "json") {
    let data;
    try {
      data = JSON.parse(content);
    } catch {
      return {
        decks: [],
        issues: [{ line: 1, level: "error", message: "JSON 格式不正确" }],
        duplicateCount,
      };
    }
    if (
      data?.format &&
      (data.format !== "keyword-backup" || data.version !== 1)
    ) {
      return {
        decks: [],
        issues: [
          { line: 1, level: "error", message: "不支持的备份格式或版本" },
        ],
        duplicateCount,
      };
    }
    const items = Array.isArray(data)
      ? [{ title, words: data }]
      : Array.isArray(data?.decks)
        ? data.decks
        : [data];
    if (data?.sessions?.length || data?.pendingSessions?.length)
      issues.push({
        line: 0,
        level: "warning",
        message:
          "此导入只新建词库；备份中的练习记录保留在原文件，整站恢复请使用 SQLite 数据库备份。",
      });
    for (const item of items) {
      if (!item || !Array.isArray(item.words)) {
        issues.push({
          line: 1,
          level: "error",
          message: "JSON 需包含 words 数组或 decks 数组",
        });
        continue;
      }
      const deck = makeDeck(item.title || title, item.description || "");
      try {
        if (item.source) deck.source = validateSource(item.source);
      } catch (error) {
        issues.push({ line: 0, level: "error", message: error.message });
      }
      if (item.deletedAt)
        issues.push({
          line: 0,
          level: "warning",
          message: `“${deck.title}”来自备份回收站，确认后将作为新词库导入。`,
        });
      item.words.forEach((word, i) =>
        add(
          deck,
          {
            term: word?.term ?? word?.en,
            meaning: word?.meaning ?? word?.cn ?? "",
          },
          i + 1,
        ),
      );
    }
  } else if (format === "csv") {
    const parsed = Papa.parse(content, {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (s) => s.trim().toLowerCase(),
    });
    parsed.errors.forEach((e) =>
      issues.push({
        line: (e.row ?? 0) + 2,
        level: "error",
        message: `CSV：${e.message}`,
      }),
    );
    const fields = parsed.meta.fields || [];
    const wordKey = fields.find((f) =>
      ["word", "term", "英文", "单词"].includes(f),
    );
    const meaningKey = fields.find((f) =>
      ["meaning", "cn", "释义", "中文"].includes(f),
    );
    const deckKey = fields.find((f) => ["deck", "book", "词库"].includes(f));
    if (!wordKey)
      issues.push({
        line: 1,
        level: "error",
        message: "CSV 表头需包含 word 或 英文，可加 meaning／释义、deck／词库",
      });
    else {
      const groups = new Map();
      parsed.data.forEach((row, i) => {
        const name = row[deckKey]?.trim() || title;
        if (!groups.has(name)) groups.set(name, makeDeck(name));
        const deck = groups.get(name);
        if (row.source?.trim()) {
          try {
            const source = validateSource(JSON.parse(row.source));
            if (
              deck.source &&
              JSON.stringify(source) !== JSON.stringify(deck.source)
            )
              throw new InputError("同一词库出现不同来源说明，请分别导入");
            deck.source = source;
          } catch (error) {
            issues.push({
              line: i + 2,
              level: "error",
              message: `来源说明无效：${error.message}`,
            });
          }
        }
        add(
          groups.get(name),
          { term: row[wordKey], meaning: row[meaningKey] || "" },
          i + 2,
        );
      });
    }
  } else {
    let current;
    content.split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim();
      if (line.startsWith("## keyword-source: ")) {
        current ||= makeDeck(title);
        try {
          current.source = validateSource(
            JSON.parse(line.slice("## keyword-source: ".length)),
          );
        } catch (error) {
          issues.push({
            line: i + 1,
            level: "error",
            message: `来源说明无效：${error.message}`,
          });
        }
        return;
      }
      if (!line || /^##|^#-/.test(line)) return;
      if (/^#\s/.test(line)) {
        current = makeDeck(line.slice(1).trim());
        return;
      }
      current ||= makeDeck(title);
      try {
        add(current, splitTextLine(line), i + 1);
      } catch (e) {
        issues.push({ line: i + 1, level: "error", message: e.message });
      }
    });
  }
  if (decks.length > MAX_DECKS_PER_IMPORT)
    issues.push({
      line: 0,
      level: "error",
      message: `每次最多导入 ${MAX_DECKS_PER_IMPORT} 个词库`,
    });
  for (const deck of decks) {
    try {
      validateDeck(deck);
    } catch (e) {
      issues.push({
        line: 0,
        level: "error",
        message: `${deck.title}：${e.message}`,
      });
    }
  }
  return { decks: decks.filter((d) => d.words.length), issues, duplicateCount };
}

export function mergeWords(existing, incoming) {
  const seen = new Set(
    existing.map((w) => `${targetFor(w.term)}\0${w.meaning}`),
  );
  return [
    ...existing,
    ...incoming
      .filter((w) => {
        const key = `${targetFor(w.term)}\0${w.meaning}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((w) => ({ ...w, id: newId() })),
  ];
}

export function exportCSV(decks) {
  const withSource = decks.some((d) => d.source);
  return (
    "\ufeff" +
    Papa.unparse(
      decks.flatMap((d) =>
        d.words.map((w, i) => ({
          word: w.term,
          meaning: w.meaning,
          deck: d.title,
          ...(withSource
            ? { source: i === 0 && d.source ? JSON.stringify(d.source) : "" }
            : {}),
        })),
      ),
      { escapeFormulae: true },
    )
  );
}

export function exportTXT(decks) {
  return decks
    .map(
      (d) =>
        "# " +
        d.title +
        "\n" +
        (d.source
          ? "## keyword-source: " + JSON.stringify(d.source) + "\n"
          : "") +
        d.words
          .map(
            (w) =>
              `${JSON.stringify(w.term)}\t${w.meaning.replace(/\r?\n/g, " ")}`,
          )
          .join("\n"),
    )
    .join("\n\n");
}

export function makeBackup(decks, sessions = []) {
  return {
    format: "keyword-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    decks,
    sessions,
  };
}
