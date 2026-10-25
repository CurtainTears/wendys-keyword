import { InputError, newId, targetFor } from "./words.mjs";

const clone = (value) => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const lexemeKey = (word) =>
  JSON.stringify([
    targetFor(word.term),
    word.meaning.normalize("NFC").replace(/\s+/g, " ").trim(),
  ]);
export function learningError(
  message,
  code = "LEARNING_CONFLICT",
  status = 409,
) {
  return Object.assign(new InputError(message, status), { code });
}
export function validId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw new InputError("学习记录标识无效");
  return id;
}
function integer(value, max = 1e7) {
  return Number.isInteger(value) && value >= 0 && value <= max;
}
function date(value) {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !Number.isFinite(Date.parse(value))
  )
    throw new InputError("练习时间无效");
  return new Date(value).toISOString();
}
export function emptyCheckpoint() {
  return {
    results: [],
    current: { typed: 0, mistakes: 0, lastWrongAt: null },
    keystrokes: 0,
    correct: 0,
    combo: 0,
    best: 0,
    durationMs: 0,
    completedAt: null,
  };
}
export function validateCheckpoint(words, raw, previous) {
  if (!raw || !Array.isArray(raw.results) || raw.results.length > words.length)
    throw new InputError("续练进度格式无效");
  const results = raw.results.map((r, i) => {
    const length = targetFor(words[i].term).length;
    if (
      !r ||
      r.id !== words[i].id ||
      !["completed", "skipped"].includes(r.status) ||
      !integer(r.mistakes) ||
      !integer(r.typed, length) ||
      (r.status === "completed" && r.typed !== length) ||
      (r.status === "skipped" && (!r.mistakes || r.typed >= length))
    )
      throw new InputError("已练词条与本轮顺序不一致");
    return {
      id: r.id,
      status: r.status,
      typed: r.typed,
      mistakes: r.mistakes,
      at: date(r.at),
      lastWrongAt: r.mistakes ? date(r.lastWrongAt) : null,
    };
  });
  const finished = results.length === words.length,
    current = raw.current;
  if (
    !current ||
    !integer(
      current.typed,
      finished ? 0 : targetFor(words[results.length].term).length - 1,
    ) ||
    !integer(current.mistakes) ||
    (finished && current.mistakes)
  )
    throw new InputError("当前词的输入位置无效");
  const value = {
    results,
    current: {
      typed: current.typed,
      mistakes: current.mistakes,
      lastWrongAt: current.mistakes ? date(current.lastWrongAt) : null,
    },
    keystrokes: raw.keystrokes,
    correct: raw.correct,
    combo: raw.combo,
    best: raw.best,
    durationMs: raw.durationMs,
    completedAt: finished ? date(raw.completedAt) : null,
  };
  const correct = results.reduce((n, r) => n + r.typed, current.typed),
    mistakes = results.reduce((n, r) => n + r.mistakes, current.mistakes);
  if (
    ![value.keystrokes, value.correct, value.combo, value.best].every((x) =>
      integer(x),
    ) ||
    value.correct !== correct ||
    value.keystrokes !== correct + mistakes ||
    value.best > correct ||
    value.combo > value.best ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    value.durationMs > 86400000
  )
    throw new InputError("续练统计与逐词进度不一致");
  if (
    previous &&
    (results.length < previous.results.length ||
      !same(results.slice(0, previous.results.length), previous.results) ||
      value.keystrokes < previous.keystrokes ||
      value.correct < previous.correct ||
      value.durationMs < previous.durationMs ||
      (results.length === previous.results.length &&
        (current.typed < previous.current.typed ||
          current.mistakes < previous.current.mistakes)) ||
      (results.length > previous.results.length &&
        results[previous.results.length].mistakes < previous.current.mistakes))
  )
    throw learningError("这份进度落后于已保存的进度，请载入最新版本");
  return value;
}
export function checkpointResult(round) {
  const c = round.checkpoint;
  return {
    id: round.id,
    deckId: round.scopeId,
    deckVersion: round.deckVersion,
    title: round.title,
    kind: round.kind,
    createdAt: c.completedAt,
    durationMs: Math.round(c.durationMs),
    keystrokes: c.keystrokes,
    correct: c.correct,
    wordsDone: c.results.filter((r) => r.status === "completed").length,
    skipped: c.results.filter((r) => r.status === "skipped").length,
    best: c.best,
    words: c.results.map((r, i) => ({
      ...round.words[i],
      status: r.status,
      mistakes: r.mistakes,
    })),
  };
}
function shuffle(values, random) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
function selectBatch(words, cap = 30) {
  const targets = new Set();
  return words.filter((w) => {
    const key = targetFor(w.term);
    if (targets.has(key) || targets.size >= cap) return false;
    targets.add(key);
    return true;
  });
}
const signature = (word) => JSON.stringify([word.term, word.meaning]);
const refKey = (ref) =>
  JSON.stringify([ref.deckId, ref.deckVersion, ref.wordId]);
function publicReview(entry) {
  const { observations, actions, serial, ...visible } = entry;
  return visible;
}
function reduceReview(entry) {
  const observations = entry.observations
    .filter((o) => o.mistakes || o.status === "completed")
    .map((o) => ({
      id: "round:" + o.roundId,
      at: o.mistakes ? o.lastWrongAt : o.at,
      kind: o.mistakes ? "wrong" : "clean",
      order: o.order || 0,
    }));
  const chronological = (a, b) =>
    a.at.localeCompare(b.at) || a.order - b.order || a.id.localeCompare(b.id);
  const events = [];
  let remaining = observations;
  // A version-checked manual decision covers every observation already known,
  // even when a device clock put that observation in the future.
  for (const action of [...entry.actions].sort((a, b) => a.order - b.order)) {
    events.push(
      ...remaining.filter((e) => e.order < action.order).sort(chronological),
    );
    remaining = remaining.filter((e) => e.order >= action.order);
    events.push({ kind: action.active ? "restore" : "master" });
  }
  events.push(...remaining.sort(chronological));
  let active = false,
    cleanStreak = 0,
    reason = "automatic";
  for (const e of events) {
    if (e.kind === "wrong" || e.kind === "restore") {
      active = true;
      cleanStreak = 0;
      reason = "automatic";
    } else if (e.kind === "master") {
      active = false;
      cleanStreak = 0;
      reason = "manual";
    } else {
      cleanStreak = Math.min(2, cleanStreak + 1);
      if (cleanStreak === 2) {
        active = false;
        reason = "automatic";
      }
    }
  }
  const wrong = entry.observations.filter((o) => o.mistakes);
  return {
    ...entry,
    active,
    cleanStreak,
    reason,
    wrongRounds: wrong.length,
    lastWrongAt:
      wrong
        .map((o) => o.lastWrongAt)
        .sort()
        .at(-1) || null,
    lastPracticedAt:
      entry.observations
        .map((o) => o.at)
        .sort()
        .at(-1) || null,
  };
}

// Business rules are shared by SQLite accounts and the browser's atomic guest store.
// The caller supplies a transaction and a repository already scoped to one owner.
export class LearningModel {
  constructor(
    repo,
    {
      getDeck,
      random = Math.random,
      now = () => new Date().toISOString(),
    } = {},
  ) {
    this.repo = repo;
    this.getDeck = getDeck;
    this.random = random;
    this.now = now;
  }
  get(kind, id) {
    return this.repo.get(kind, id);
  }
  put(kind, id, value) {
    this.repo.put(kind, id, value);
    if (kind === "round") {
      this.repo.put("roundMeta", id, {
        id: value.id,
        scopeId: value.scopeId,
        kind: value.kind,
        title: value.title,
        generation: value.generation,
        version: value.version,
        status: value.status,
        updatedAt: value.updatedAt,
        done: value.checkpoint.results.length,
        total: value.words.length,
      });
      if (value.status === "done") this.repo.put("session", id, value.result);
    }
    return value;
  }
  all(kind) {
    return this.repo.all(kind);
  }
  operation(id, payload, action) {
    validId(id);
    const existing = this.get("operation", id),
      input = JSON.stringify(payload);
    if (existing) {
      if (existing.input !== input)
        throw learningError("该操作已用于其他内容，请重新操作");
      return clone(existing.result);
    }
    const result = action();
    this.put("operation", id, {
      input,
      kind: payload.action === "review" ? "review" : "round",
      id: result.id,
      result: clone(result),
    });
    return result;
  }
  round(id) {
    validId(id);
    const round = this.get("round", id);
    if (!round) throw new InputError("练习不存在或不可访问", 404);
    return round;
  }
  planFor(deck) {
    let plan = this.get("plan", deck.id);
    if (!plan) {
      const coverage = new Map(
        (this.get("coverage", deck.id)?.words || []).map((w) => [
          w.id,
          signature(w),
        ]),
      );
      const seen = deck.words
        .filter((w) => coverage.get(w.id) === signature(w))
        .map((w) => w.id);
      plan = {
        id: deck.id,
        title: deck.title,
        deckVersion: deck.version,
        cycle: 1,
        order: shuffle(
          deck.words.map((w) => w.id),
          this.random,
        ),
        seen,
        skipped: [],
      };
    } else if (plan.deckVersion !== deck.version) {
      const old = this.getDeck(deck.id, plan.deckVersion),
        oldWords = new Map(old.words.map((w) => [w.id, w])),
        current = new Map(deck.words.map((w) => [w.id, w]));
      const unchanged = (id) =>
        current.has(id) &&
        oldWords.has(id) &&
        signature(current.get(id)) === signature(oldWords.get(id));
      const kept = plan.order.filter((id) => current.has(id));
      plan = {
        ...plan,
        title: deck.title,
        deckVersion: deck.version,
        order: [
          ...kept,
          ...shuffle(
            deck.words.filter((w) => !oldWords.has(w.id)).map((w) => w.id),
            this.random,
          ),
        ],
        seen: plan.seen.filter(unchanged),
        skipped: plan.skipped.filter(unchanged),
      };
    }
    return this.put("plan", deck.id, plan);
  }
  createRound({
    scopeId,
    kind,
    title,
    deckVersion,
    words,
    cycle = null,
    parentId = null,
  }) {
    if (!words.length) throw new InputError("没有可练习的词条");
    const id = newId(),
      now = this.now();
    const round = {
      id,
      scopeId,
      kind,
      title,
      deckVersion,
      cycle,
      parentId,
      words: words.map((w, i) => ({ ...w, id: "item_" + i })),
      generation: 1,
      sequence: 0,
      version: 1,
      status: "active",
      createdAt: now,
      updatedAt: now,
      checkpoint: emptyCheckpoint(),
    };
    this.put("pointer", scopeId, { id });
    return this.put("round", id, round);
  }
  start({ deckId, operationId, restart = false }) {
    validId(deckId);
    if (typeof restart !== "boolean") throw new InputError("重新开始选项无效");
    return this.operation(
      operationId,
      { action: "start", deckId, restart },
      () => {
        const pointer = this.get("pointer", deckId),
          previous = pointer && this.get("round", pointer.id);
        if (previous?.status === "active" && !restart)
          return this.claimRound(previous);
        if (previous?.status === "active" && restart) {
          this.put("round", previous.id, {
            ...previous,
            status: "archived",
            updatedAt: this.now(),
          });
          return this.createRound({ ...previous, words: previous.words });
        }
        if (deckId === "review") {
          const entries = this.reviews().filter((e) => e.active);
          const selected = selectBatch(entries);
          const words = selected.map((e) => ({
            term: e.term,
            meaning: e.meaning,
            reviewId: e.id,
            source: e.sources[0],
            sources: e.sources,
          }));
          return this.createRound({
            scopeId: "review",
            kind: "review",
            title: "我的错词",
            deckVersion: 1,
            words,
          });
        }
        const deck = this.getDeck(deckId);
        let plan = this.planFor(deck);
        if (!deck.words.length) throw new InputError("这个词库还没有词条");
        if (plan.seen.length === plan.order.length)
          plan = this.put("plan", deck.id, {
            ...plan,
            cycle: plan.cycle + 1,
            seen: [],
            skipped: [],
            order: shuffle(
              deck.words.map((w) => w.id),
              this.random,
            ),
          });
        const seen = new Set(plan.seen),
          byId = new Map(deck.words.map((w) => [w.id, w]));
        const words = selectBatch(
          plan.order.filter((id) => !seen.has(id)).map((id) => byId.get(id)),
        ).map((w) => ({
          ...w,
          source: {
            deckId: deck.id,
            deckVersion: deck.version,
            wordId: w.id,
            title: deck.title,
            ...(deck.source ? { provenance: deck.source } : {}),
          },
        }));
        return this.createRound({
          scopeId: deckId,
          kind: "study",
          title: deck.title,
          deckVersion: deck.version,
          cycle: plan.cycle,
          words,
        });
      },
    );
  }
  claimRound(round) {
    if (round.status !== "active")
      throw learningError("这轮练习已经结束，请开始下一轮");
    return this.put("round", round.id, {
      ...round,
      generation: round.generation + 1,
      sequence: 0,
      version: round.version + 1,
      updatedAt: this.now(),
    });
  }
  claim(id, { operationId, version }) {
    return this.operation(operationId, { action: "claim", id, version }, () => {
      const round = this.round(id);
      if (round.version !== version)
        throw learningError("其他设备已更新进度，请刷新后继续");
      const updated = this.claimRound(round);
      this.put("pointer", round.scopeId, { id });
      return updated;
    });
  }
  retry(id, { operationId, wordIds }) {
    if (!Array.isArray(wordIds) || !wordIds.length || wordIds.length > 30)
      throw new InputError("请选择本轮错词");
    return this.operation(operationId, { action: "retry", id, wordIds }, () => {
      const round = this.round(id),
        words = round.words.filter((w) => wordIds.includes(w.id));
      if (words.length !== new Set(wordIds).size)
        throw new InputError("错词不属于本轮练习");
      return this.createRound({
        scopeId: "retry_" + newId(),
        kind: "retry",
        title: round.title + " · 本轮错词",
        deckVersion: round.deckVersion,
        words,
        parentId: id,
      });
    });
  }
  fork(id, { operationId, checkpoint }) {
    return this.operation(
      operationId,
      { action: "fork", id, checkpoint },
      () => {
        const source = this.round(id),
          value = validateCheckpoint(source.words, checkpoint);
        const round = this.createRound({
          scopeId: "extra_" + newId(),
          kind: "extra",
          title: source.title + " · 本机保留轮次",
          deckVersion: source.deckVersion,
          words: source.words,
          parentId: id,
        });
        round.attemptOrigins = source.words.map((_, i) =>
          i < value.results.length ||
          (i === value.results.length &&
            (value.current.typed || value.current.mistakes))
            ? source.attemptOrigins?.[i] || source.id
            : null,
        );
        this.put("round", round.id, round);
        return this.checkpoint(round.id, {
          generation: 1,
          sequence: 1,
          checkpoint: value,
        });
      },
    );
  }
  checkpoint(id, { generation, sequence, checkpoint }) {
    const round = this.round(id);
    if (!integer(generation) || !integer(sequence) || !sequence)
      throw new InputError("进度序号无效");
    if (round.generation !== generation || round.status === "archived")
      throw learningError(
        "这轮进度已在另一设备继续，本机副本仍保留。",
        "ROUND_TAKEN_OVER",
      );
    if (sequence <= round.sequence) return round;
    if (round.status === "done") return round;
    const value = validateCheckpoint(round.words, checkpoint, round.checkpoint),
      now = this.now();
    const updated = {
      ...round,
      checkpoint: value,
      sequence,
      version: round.version + 1,
      updatedAt: now,
      status: value.completedAt ? "done" : "active",
    };
    for (let i = 0; i < value.results.length; i++) {
      const result = value.results[i],
        word = round.words[i];
      this.observe(word, {
        ...result,
        roundId: round.attemptOrigins?.[i] || round.id,
      });
      if (round.kind === "study") this.cover(round, word, result);
    }
    if (value.current.mistakes) {
      const word = round.words[value.results.length];
      this.observe(word, {
        ...value.current,
        status: "active",
        at: value.current.lastWrongAt,
        roundId: round.attemptOrigins?.[value.results.length] || round.id,
      });
    }
    if (value.completedAt) updated.result = checkpointResult(updated);
    return this.put("round", id, updated);
  }
  cover(round, word, result) {
    const plan = this.get("plan", round.scopeId);
    if (!plan || plan.cycle !== round.cycle) return;
    const ref = word.source;
    // A resumed old snapshot never marks a newly edited word as already seen.
    if (plan.deckVersion !== ref.deckVersion) return;
    let changed = false;
    if (!plan.seen.includes(ref.wordId)) {
      plan.seen.push(ref.wordId);
      changed = true;
    }
    if (result.status === "skipped" && !plan.skipped.includes(ref.wordId)) {
      plan.skipped.push(ref.wordId);
      changed = true;
    }
    if (changed) this.put("plan", round.scopeId, plan);
  }
  observe(word, observation) {
    const key = lexemeKey(word),
      pointer = this.get("lexeme", key);
    let entry = pointer && this.get("review", pointer.id);
    if (!entry && !observation.mistakes) return;
    if (!entry) {
      entry = {
        id: newId(),
        term: word.term,
        meaning: word.meaning,
        version: 0,
        sources: [],
        observations: [],
        actions: [],
      };
      this.put("lexeme", key, { id: entry.id });
    }
    const source = word.source,
      sources = word.sources || [source];
    for (const ref of sources.filter(Boolean))
      if (!entry.sources.some((s) => refKey(s) === refKey(ref)))
        entry.sources.push(clone(ref));
    const o = {
      roundId: observation.roundId,
      status: observation.status,
      mistakes: observation.mistakes,
      at: observation.at,
      lastWrongAt: observation.mistakes ? observation.lastWrongAt : null,
    };
    const existing = entry.observations.findIndex(
      (o) => o.roundId === observation.roundId,
    );
    if (existing >= 0) {
      const prior = entry.observations[existing];
      if (prior.mistakes) {
        o.mistakes = Math.max(prior.mistakes, o.mistakes);
        o.lastWrongAt = [prior.lastWrongAt, o.lastWrongAt]
          .filter(Boolean)
          .sort()
          .at(-1);
      }
      if (prior.status !== "active" && o.status === "active")
        o.status = prior.status;
      o.at = [prior.at, o.at].sort().at(-1);
      const { order, ...details } = entry.observations[existing];
      if (same(details, o)) return;
    }
    const priorOrder =
      existing >= 0 && entry.observations[existing].mistakes === o.mistakes
        ? entry.observations[existing].order
        : undefined;
    if (priorOrder !== undefined) o.order = priorOrder;
    else {
      entry.serial = (entry.serial || 0) + 1;
      o.order = entry.serial;
    }
    if (existing >= 0) entry.observations[existing] = o;
    else entry.observations.push(o);
    entry = reduceReview({ ...entry, version: entry.version + 1 });
    this.put("review", entry.id, entry);
  }
  reviewAction(id, { version, active, operationId }) {
    validId(id);
    if (typeof active !== "boolean") throw new InputError("错词状态无效");
    return this.operation(
      operationId,
      { action: "review", id, version, active },
      () => {
        const entry = this.get("review", id);
        if (!entry) throw new InputError("错词不存在或不可访问", 404);
        if (entry.version !== version)
          throw learningError("这条错词已有新的练习结果，请刷新后再操作");
        entry.serial = (entry.serial || 0) + 1;
        entry.actions.push({
          id: operationId,
          at: this.now(),
          active,
          order: entry.serial,
        });
        return publicReview(
          this.put(
            "review",
            id,
            reduceReview({ ...entry, version: entry.version + 1 }),
          ),
        );
      },
    );
  }
  reviews() {
    return this.all("review")
      .map(publicReview)
      .sort(
        (a, b) =>
          b.wrongRounds - a.wrongRounds ||
          (b.lastWrongAt || "").localeCompare(a.lastWrongAt || ""),
      );
  }
  recordLegacy(record) {
    for (const w of record.words) {
      const source = w.source || {
        deckId: record.deckId,
        deckVersion: record.deckVersion,
        wordId: w.id,
        title: record.title,
      };
      this.observe(
        { ...w, source },
        {
          roundId: "legacy_" + record.id,
          status: w.status,
          mistakes: w.mistakes,
          at: record.createdAt,
          lastWrongAt: w.mistakes ? record.createdAt : null,
        },
      );
      const coverage = this.get("coverage", source.deckId) || { words: [] };
      const entry = { id: source.wordId, term: w.term, meaning: w.meaning };
      const index = coverage.words.findIndex((w) => w.id === entry.id);
      if (index >= 0) coverage.words[index] = entry;
      else coverage.words.push(entry);
      this.put("coverage", source.deckId, coverage);
    }
  }
  summary() {
    const rounds = this.all("roundMeta")
      .filter((r) => r.status === "active")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((r) => ({
        id: r.id,
        scopeId: r.scopeId,
        kind: r.kind,
        title: r.title,
        generation: r.generation,
        version: r.version,
        updatedAt: r.updatedAt,
        done: r.done,
        total: r.total,
      }));
    const plans = this.all("plan").map((p) => ({
      id: p.id,
      title: p.title,
      deckVersion: p.deckVersion,
      cycle: p.cycle,
      seen: p.seen.length,
      skipped: p.skipped.length,
      total: p.order.length,
    }));
    const reviews = this.reviews();
    return {
      rounds,
      plans,
      reviewCount: reviews.filter((e) => e.active).length,
      masteredCount: reviews.filter((e) => !e.active).length,
    };
  }
  sessions() {
    return this.all("session");
  }
}
export class MemoryLearningRepo {
  constructor(records = []) {
    this.records = clone(records);
  }
  get(kind, id) {
    const r = this.records.find((r) => r.kind === kind && r.id === id);
    return r ? clone(r.value) : undefined;
  }
  put(kind, id, value) {
    const i = this.records.findIndex((r) => r.kind === kind && r.id === id),
      r = { kind, id, value: clone(value) };
    if (i < 0) this.records.push(r);
    else this.records[i] = r;
  }
  all(kind) {
    return this.records
      .filter((r) => r.kind === kind)
      .map((r) => clone(r.value));
  }
}
