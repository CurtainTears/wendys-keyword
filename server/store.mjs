import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { newId, validateDeck, InputError } from "../shared/words.mjs";
import { loadCatalog, syncCatalog } from "./catalog.mjs";
import { LearningStore } from "./learning.mjs";

export function openDatabase(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, "keyword.sqlite");
  const db = new DatabaseSync(filename);
  fs.chmodSync(filename, 0o600);
  db.exec(
    "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
  );
  return db;
}

export class Store {
  constructor(
    db,
    {
      seedFile,
      legacyFile,
      catalogFile = path.join(path.dirname(seedFile), "catalog.json"),
    },
  ) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decks (
        id TEXT PRIMARY KEY, owner_id TEXT REFERENCES user(id) ON DELETE CASCADE,
        title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS decks_owner ON decks(owner_id, deleted_at);
      CREATE TABLE IF NOT EXISTS deck_sources (
        deck_id TEXT PRIMARY KEY REFERENCES decks(id) ON DELETE CASCADE,
        source TEXT, position INTEGER
      );
      CREATE TABLE IF NOT EXISTS words (
        deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE, id TEXT NOT NULL,
        position INTEGER NOT NULL, term TEXT NOT NULL, meaning TEXT NOT NULL,
        PRIMARY KEY(deck_id, id)
      );
      CREATE TABLE IF NOT EXISTS deck_revisions (
        deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE, version INTEGER NOT NULL,
        snapshot TEXT NOT NULL, PRIMARY KEY(deck_id, version)
      );
      CREATE TABLE IF NOT EXISTS practice_sessions (
        id TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        deck_id TEXT NOT NULL REFERENCES decks(id), deck_version INTEGER NOT NULL,
        created_at TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(owner_id, id)
      );
      CREATE INDEX IF NOT EXISTS sessions_owner ON practice_sessions(owner_id, created_at);
      CREATE TABLE IF NOT EXISTS legacy_scores (
        bank TEXT NOT NULL, position INTEGER NOT NULL, record TEXT NOT NULL,
        PRIMARY KEY(bank, position)
      );
      CREATE TABLE IF NOT EXISTS import_operations (
        owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, id TEXT NOT NULL,
        payload TEXT NOT NULL, deck_ids TEXT NOT NULL, PRIMARY KEY(owner_id,id)
      );
    `);
    const catalog = loadCatalog(seedFile, catalogFile);
    this.transaction(() => {
      syncCatalog(this, catalog);
      if (!db.prepare("SELECT 1 FROM app_meta WHERE key='legacy-v1'").get()) {
        if (fs.existsSync(legacyFile)) {
          const legacy = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
          if (!legacy || typeof legacy !== "object" || Array.isArray(legacy))
            throw new Error("leaderboard.json 格式不正确，原文件未修改");
          const put = db.prepare("INSERT INTO legacy_scores VALUES (?, ?, ?)");
          for (const [bank, records] of Object.entries(legacy)) {
            if (!Array.isArray(records))
              throw new Error("旧排行榜词库数据不是数组，原文件未修改");
            records.forEach((r, i) => put.run(bank, i, JSON.stringify(r)));
          }
        }
        db.prepare("INSERT INTO app_meta VALUES ('legacy-v1', '1')").run();
      }
    });
    this.learning = new LearningStore(this);
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  metadata(row) {
    const provenance = this.db
      .prepare("SELECT source FROM deck_sources WHERE deck_id=?")
      .get(row.id);
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      version: row.version,
      builtin: row.owner_id === null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      ...(provenance?.source ? { source: JSON.parse(provenance.source) } : {}),
      wordCount: Number(
        row.word_count ??
          this.db
            .prepare("SELECT count(*) AS n FROM words WHERE deck_id=?")
            .get(row.id).n,
      ),
    };
  }
  list(owner, deleted = false) {
    const rows =
      owner === null
        ? this.db
            .prepare(
              "SELECT d.*, (SELECT count(*) FROM words w WHERE w.deck_id=d.id) AS word_count FROM decks d WHERE owner_id IS NULL AND deleted_at IS NULL ORDER BY COALESCE((SELECT position FROM deck_sources s WHERE s.deck_id=d.id),2147483647),created_at,id",
            )
            .all()
        : this.db
            .prepare(
              `SELECT d.*, (SELECT count(*) FROM words w WHERE w.deck_id=d.id) AS word_count FROM decks d WHERE owner_id=? AND deleted_at IS ${deleted ? "NOT NULL" : "NULL"} ORDER BY updated_at DESC,id`,
            )
            .all(owner);
    return rows.map((row) => this.metadata(row));
  }
  get(id, owner, { includeDeleted = false, writable = false } = {}) {
    const row = this.db.prepare("SELECT * FROM decks WHERE id=?").get(id);
    if (
      !row ||
      (row.owner_id !== null && row.owner_id !== owner) ||
      (!includeDeleted && row.deleted_at)
    )
      throw new InputError("词库不存在或不可访问", 404);
    if (writable && (row.owner_id === null || row.owner_id !== owner))
      throw new InputError("内置词库只读，请复制到我的词库后编辑", 403);
    const words = this.db
      .prepare(
        "SELECT id,term,meaning FROM words WHERE deck_id=? ORDER BY position",
      )
      .all(id)
      .map((w) => ({ ...w }));
    return { ...this.metadata(row), words };
  }
  revision(id, owner, version) {
    const row = this.db
      .prepare("SELECT owner_id FROM decks WHERE id=?")
      .get(id);
    if (!row || (row.owner_id !== null && row.owner_id !== owner))
      throw new InputError("词库不存在或不可访问", 404);
    const saved = this.db
      .prepare(
        "SELECT snapshot FROM deck_revisions WHERE deck_id=? AND version=?",
      )
      .get(id, version);
    if (!saved) throw new InputError("词库版本不存在", 404);
    return { ...JSON.parse(saved.snapshot), id, version };
  }
  writeWords(id, words) {
    this.db.prepare("DELETE FROM words WHERE deck_id=?").run(id);
    const put = this.db.prepare("INSERT INTO words VALUES (?, ?, ?, ?, ?)");
    words.forEach((w, i) => put.run(id, w.id, i, w.term, w.meaning));
  }
  snapshot(id, version, deck) {
    this.db
      .prepare("INSERT INTO deck_revisions VALUES (?, ?, ?)")
      .run(id, version, JSON.stringify(deck));
  }
  writeSource(id, source, position = null) {
    this.db
      .prepare(
        "INSERT INTO deck_sources VALUES (?, ?, ?) ON CONFLICT(deck_id) DO UPDATE SET source=excluded.source,position=COALESCE(excluded.position,deck_sources.position)",
      )
      .run(id, source ? JSON.stringify(source) : null, position);
  }
  insert(owner, deck, id = newId()) {
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO decks VALUES (?, ?, ?, ?, 1, ?, ?, NULL)")
      .run(id, owner, deck.title, deck.description, now, now);
    this.writeWords(id, deck.words);
    this.writeSource(id, deck.source);
    this.snapshot(id, 1, deck);
    return this.get(id, owner);
  }
  create(owner, raw) {
    const deck = validateDeck(raw);
    return this.transaction(() => this.insert(owner, deck));
  }
  import(owner, raw, operationId) {
    if (!Array.isArray(raw) || !raw.length || raw.length > 30)
      throw new InputError("每次导入 1–30 个词库");
    if (
      operationId != null &&
      (typeof operationId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(operationId))
    )
      throw new InputError("导入操作标识无效");
    const payload = JSON.stringify(raw);
    const decks = raw.map(validateDeck);
    return this.transaction(() => {
      if (operationId) {
        const previous = this.db
          .prepare(
            "SELECT payload,deck_ids FROM import_operations WHERE owner_id=? AND id=?",
          )
          .get(owner, operationId);
        if (previous) {
          if (previous.payload !== payload)
            throw new InputError("导入内容已改变，请使用新的导入操作", 409);
          return JSON.parse(previous.deck_ids).map((id) =>
            this.get(id, owner, { includeDeleted: true }),
          );
        }
      }
      const created = decks.map((d) =>
        this.insert(owner, {
          ...d,
          words: d.words.map((w) => ({ ...w, id: newId() })),
        }),
      );
      if (operationId)
        this.db
          .prepare("INSERT INTO import_operations VALUES (?, ?, ?, ?)")
          .run(
            owner,
            operationId,
            payload,
            JSON.stringify(created.map((d) => d.id)),
          );
      return created;
    });
  }
  update(owner, id, raw) {
    const deck = validateDeck(raw);
    if (!Number.isInteger(raw.version))
      throw new InputError("缺少词库版本，请刷新后重试");
    return this.transaction(() => {
      const current = this.get(id, owner, { writable: true });
      if (!deck.source && current.source) deck.source = current.source;
      if (current.version !== raw.version)
        throw new InputError(
          "词库已在另一个设备更新。你的编辑仍在，请先导出草稿或载入最新版本。",
          409,
        );
      const version = current.version + 1;
      this.db
        .prepare(
          "UPDATE decks SET title=?,description=?,version=?,updated_at=? WHERE id=? AND owner_id=?",
        )
        .run(
          deck.title,
          deck.description,
          version,
          new Date().toISOString(),
          id,
          owner,
        );
      this.writeWords(id, deck.words);
      this.writeSource(id, deck.source);
      this.snapshot(id, version, deck);
      return this.get(id, owner);
    });
  }
  trash(owner, id, version, restore = false) {
    if (!Number.isInteger(version)) throw new InputError("缺少词库版本");
    return this.transaction(() => {
      const current = this.get(id, owner, {
        writable: true,
        includeDeleted: true,
      });
      if (current.version !== version)
        throw new InputError("词库已更新，请刷新后重试", 409);
      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE decks SET deleted_at=?,version=version+1,updated_at=? WHERE id=? AND owner_id=?",
        )
        .run(restore ? null : now, now, id, owner);
      this.snapshot(id, version + 1, {
        title: current.title,
        description: current.description,
        words: current.words,
        ...(current.source ? { source: current.source } : {}),
      });
      return this.get(id, owner, { includeDeleted: true });
    });
  }
  sessions(owner, all = false) {
    return this.db
      .prepare(
        "SELECT result,created_at FROM practice_sessions WHERE owner_id=? UNION ALL SELECT data AS result,json_extract(data,'$.createdAt') AS created_at FROM learning_documents WHERE owner_id=? AND kind='session' ORDER BY created_at DESC" +
          (all ? "" : " LIMIT 100"),
      )
      .all(owner, owner)
      .map((row) => JSON.parse(row.result));
  }
  saveSession(owner, data) {
    return this.transaction(() => {
      const result = this.saveLegacySession(owner, data);
      this.learning.model(owner).recordLegacy(result);
      return result;
    });
  }
  saveLegacySession(owner, data) {
    if (
      !data ||
      typeof data.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(data.id)
    )
      throw new InputError("练习记录标识无效");
    if (typeof data.deckId !== "string" || !Number.isInteger(data.deckVersion))
      throw new InputError("练习记录缺少词库版本");
    if (
      data.createdAt !== undefined &&
      (typeof data.createdAt !== "string" ||
        data.createdAt.length > 40 ||
        !Number.isFinite(Date.parse(data.createdAt)))
    )
      throw new InputError("练习完成时间无效");
    this.get(data.deckId, owner, { includeDeleted: true });
    const revision = this.db
      .prepare(
        "SELECT snapshot FROM deck_revisions WHERE deck_id=? AND version=?",
      )
      .get(data.deckId, data.deckVersion);
    if (!revision) throw new InputError("练习对应的词库版本不存在");
    const snapshot = JSON.parse(revision.snapshot),
      integers = ["keystrokes", "correct", "wordsDone", "skipped", "best"];
    if (
      integers.some(
        (k) => !Number.isInteger(data[k]) || data[k] < 0 || data[k] > 1e7,
      ) ||
      data.correct > data.keystrokes ||
      data.best > data.correct ||
      !Number.isFinite(data.durationMs) ||
      data.durationMs < 0 ||
      data.durationMs > 86400000 ||
      !Array.isArray(data.words) ||
      !data.words.length ||
      data.words.length > 30
    )
      throw new InputError("练习统计无效");
    const source = new Map(snapshot.words.map((w) => [w.id, w])),
      seen = new Set();
    const words = data.words.map((w) => {
      if (
        !source.has(w.id) ||
        seen.has(w.id) ||
        !["completed", "skipped"].includes(w.status) ||
        !Number.isInteger(w.mistakes) ||
        w.mistakes < 0 ||
        w.mistakes > data.keystrokes
      )
        throw new InputError("练习词条与原词库不匹配");
      seen.add(w.id);
      return { ...source.get(w.id), status: w.status, mistakes: w.mistakes };
    });
    if (
      words.filter((w) => w.status === "completed").length !== data.wordsDone ||
      words.filter((w) => w.status === "skipped").length !== data.skipped
    )
      throw new InputError("完成词数与练习明细不一致");
    const result = {
      id: data.id,
      deckId: data.deckId,
      deckVersion: data.deckVersion,
      title: snapshot.title,
      createdAt:
        data.createdAt === undefined
          ? new Date().toISOString()
          : new Date(data.createdAt).toISOString(),
      durationMs: Math.round(data.durationMs),
      ...Object.fromEntries(integers.map((k) => [k, data[k]])),
      words,
    };
    this.db
      .prepare(
        "INSERT INTO practice_sessions VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id,id) DO NOTHING",
      )
      .run(
        data.id,
        owner,
        data.deckId,
        data.deckVersion,
        result.createdAt,
        JSON.stringify(result),
      );
    return JSON.parse(
      this.db
        .prepare(
          "SELECT result FROM practice_sessions WHERE owner_id=? AND id=?",
        )
        .get(owner, data.id).result,
    );
  }
  legacyDump() {
    const result = Object.create(null);
    for (const row of this.db
      .prepare("SELECT * FROM legacy_scores ORDER BY bank,position")
      .all())
      (result[row.bank] ||= []).push(JSON.parse(row.record));
    return result;
  }
}
