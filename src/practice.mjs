import { isPracticeChar, targetFor, newId } from "../shared/words.mjs";
import { validateCheckpoint } from "../shared/learning.mjs";

export function createPractice({
  clock = () => performance.now(),
  random = Math.random,
  cap = 30,
  now = () => new Date().toISOString(),
} = {}) {
  const state = {
    status: "idle",
    running: false,
    done: false,
    pool: [],
    word: "",
    cn: "",
    item: null,
    typed: 0,
    combo: 0,
    best: 0,
    keystrokes: 0,
    correct: 0,
    wordsDone: 0,
    skipped: 0,
    wrong: Object.create(null),
    round: [],
    poolIdx: 0,
    poolLen: 0,
    activeMs: 0,
    startedAt: null,
    shake: 0,
  };
  let deck;
  let completedAt = null,
    waitForInput = false;
  const elapsed = () =>
    state.activeMs + (state.startedAt === null ? 0 : clock() - state.startedAt);
  const stopClock = () => {
    state.activeMs = elapsed();
    state.startedAt = null;
  };
  function advance() {
    if (state.poolIdx >= state.pool.length) {
      stopClock();
      state.status = "done";
      state.running = false;
      state.done = true;
      completedAt ||= now();
      return;
    }
    const word = state.pool[state.poolIdx++];
    state.item = { ...word, mistakes: 0, lastWrongAt: null };
    state.word = targetFor(word.term);
    state.cn = word.meaning;
    state.typed = 0;
  }
  function start(selectedDeck, { ordered = false, id = newId() } = {}) {
    deck = structuredClone(selectedDeck);
    completedAt = null;
    waitForInput = false;
    const shuffled = [...deck.words];
    for (let i = ordered ? 0 : shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const seen = new Set();
    const pool = shuffled.filter((w) => {
      const key = targetFor(w.term);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    Object.assign(state, {
      id,
      status: "ready",
      running: true,
      done: false,
      pool: pool.slice(0, cap),
      word: "",
      cn: "",
      item: null,
      typed: 0,
      combo: 0,
      best: 0,
      keystrokes: 0,
      correct: 0,
      wordsDone: 0,
      skipped: 0,
      wrong: Object.create(null),
      round: [],
      poolIdx: 0,
      poolLen: Math.min(pool.length, cap),
      activeMs: 0,
      startedAt: null,
    });
    advance();
    return state;
  }
  function begin() {
    if (!state.running || state.status === "paused") return false;
    if (state.startedAt === null) state.startedAt = clock();
    waitForInput = false;
    state.status = "running";
    return true;
  }
  function markWrong(ch, want) {
    const w = state.item,
      entry = (state.wrong[w.id] ||= { ...w, n: 0, chars: {} });
    entry.n++;
    w.mistakes++;
    w.lastWrongAt = now();
    const key = JSON.stringify([ch, want]);
    entry.chars[key] = (entry.chars[key] || 0) + 1;
  }
  function input(value) {
    const ch = targetFor(value);
    if (!isPracticeChar(ch) || !begin()) return { kind: "ignored" };
    state.keystrokes++;
    const index = state.typed;
    if (ch !== state.word[index]) {
      const brokeCombo = state.combo > 0;
      markWrong(ch, state.word[index]);
      state.combo = 0;
      return { kind: "wrong", index, brokeCombo };
    }
    state.correct++;
    state.typed++;
    state.combo++;
    state.best = Math.max(state.best, state.combo);
    if (state.typed < state.word.length) return { kind: "correct", index };
    state.wordsDone++;
    state.round.push({
      ...state.item,
      typed: state.typed,
      at: now(),
      status: "completed",
    });
    advance();
    return { kind: state.done ? "done" : "word", index };
  }
  function skip() {
    if (!begin()) return { kind: "ignored" };
    state.keystrokes++;
    state.combo = 0;
    state.skipped++;
    markWrong("跳过", state.word[state.typed]);
    state.round.push({
      ...state.item,
      typed: state.typed,
      at: now(),
      status: "skipped",
    });
    advance();
    return { kind: state.done ? "done" : "skip" };
  }
  function pause() {
    if (!state.running || state.status === "paused") return;
    stopClock();
    state.status = "paused";
  }
  function resume() {
    if (state.status !== "paused") return;
    state.status = state.keystrokes && !waitForInput ? "running" : "ready";
    if (state.keystrokes && !waitForInput) state.startedAt = clock();
  }
  function snapshot() {
    return {
      results: state.round.map((w) => ({
        id: w.id,
        status: w.status,
        typed: w.typed,
        mistakes: w.mistakes,
        at: w.at,
        lastWrongAt: w.lastWrongAt,
      })),
      current: {
        typed: state.done ? 0 : state.typed,
        mistakes: state.done ? 0 : state.item?.mistakes || 0,
        lastWrongAt: state.done ? null : state.item?.lastWrongAt || null,
      },
      keystrokes: state.keystrokes,
      correct: state.correct,
      combo: state.combo,
      best: state.best,
      durationMs: elapsed(),
      completedAt,
    };
  }
  function restore(selectedDeck, checkpoint, id) {
    const saved = validateCheckpoint(selectedDeck.words, checkpoint);
    start(selectedDeck, { ordered: true, id });
    const index = saved.results.length;
    Object.assign(state, {
      round: saved.results.map((r, i) => ({ ...state.pool[i], ...r })),
      poolIdx: Math.min(index + 1, state.pool.length),
      keystrokes: saved.keystrokes,
      correct: saved.correct,
      combo: saved.combo,
      best: saved.best,
      activeMs: saved.durationMs,
      startedAt: null,
      wordsDone: saved.results.filter((r) => r.status === "completed").length,
      skipped: saved.results.filter((r) => r.status === "skipped").length,
      done: !!saved.completedAt,
      running: !saved.completedAt,
      status: saved.completedAt ? "done" : "ready",
      typed: saved.current.typed,
    });
    completedAt = saved.completedAt;
    waitForInput = true;
    if (!state.done) {
      state.item = { ...state.pool[index], ...saved.current };
      state.word = targetFor(state.item.term);
      state.cn = state.item.meaning;
    }
    state.wrong = Object.create(null);
    for (const w of [...state.round, ...(state.done ? [] : [state.item])])
      if (w.mistakes) state.wrong[w.id] = { ...w, n: w.mistakes, chars: {} };
    return state;
  }
  function result() {
    return {
      id: state.id,
      deckId: deck.id,
      deckVersion: deck.version,
      title: deck.title,
      createdAt: completedAt || now(),
      durationMs: Math.round(elapsed()),
      keystrokes: state.keystrokes,
      correct: state.correct,
      wordsDone: state.wordsDone,
      skipped: state.skipped,
      best: state.best,
      words: state.round.map((w) => ({
        id: w.id,
        term: w.term,
        meaning: w.meaning,
        status: w.status,
        mistakes: w.mistakes,
        ...(w.source ? { source: w.source } : {}),
      })),
    };
  }
  function metrics() {
    const duration = elapsed();
    return {
      accuracy: state.keystrokes
        ? Math.round((state.correct / state.keystrokes) * 100)
        : 100,
      wpm:
        duration < 500 ? 0 : Math.round(state.correct / 5 / (duration / 60000)),
      duration,
    };
  }
  return {
    state,
    start,
    restore,
    snapshot,
    input,
    skip,
    pause,
    resume,
    result,
    metrics,
    elapsed,
  };
}
