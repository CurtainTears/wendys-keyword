import { test } from "node:test";
import assert from "node:assert/strict";
import { LearningClient } from "../src/learning.mjs";
import { LearningModel, MemoryLearningRepo } from "../shared/learning.mjs";
import { createPractice } from "../src/practice.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { resolve, promise };
}
function localStore() {
  const rows = new Map();
  return {
    fail: false,
    async get(kind, id) {
      return structuredClone(rows.get(kind + ":" + id));
    },
    async all(kind) {
      return [...rows]
        .filter(([key]) => key.startsWith(kind + ":"))
        .map(([, value]) => structuredClone(value));
    },
    async put(kind, value) {
      if (this.fail) throw new Error("quota");
      rows.set(kind + ":" + value.id, structuredClone(value));
    },
    async remove(kind, id) {
      rows.delete(kind + ":" + id);
    },
    async mutate(kind, id, action) {
      if (this.fail) throw new Error("quota");
      const { value, result } = action(
        structuredClone(rows.get(kind + ":" + id)),
      );
      rows.set(kind + ":" + id, structuredClone(value));
      return structuredClone(result);
    },
  };
}
function fixture(t, { guest = false, count = 1 } = {}) {
  const local = localStore(),
    state = { owner: guest ? "guest" : "a", epoch: 0 },
    calls = [],
    statuses = [];
  const deck = {
    id: "deck",
    title: "测试词库",
    version: 1,
    words: Array.from({ length: count }, (_, i) => ({
      id: "w" + i,
      term: count === 1 ? "sun" : "word" + i,
      meaning: "词" + i,
    })),
  };
  const models = new Map();
  let online = true,
    intercept;
  const model = (owner) => {
    if (!models.has(owner))
      models.set(
        owner,
        new LearningModel(new MemoryLearningRepo(), {
          getDeck: () => deck,
          random: () => 0.99,
        }),
      );
    return models.get(owner);
  };
  const api = async (url, { method = "GET", body } = {}) => {
    calls.push({
      owner: state.owner,
      url,
      method,
      body: structuredClone(body),
    });
    if (!online) throw Object.assign(new Error("offline"), { status: 0 });
    const m = model(state.owner);
    if (url === "/api/learning") return { summary: m.summary() };
    if (url === "/api/learning/reviews") return { reviews: m.reviews() };
    if (url === "/api/learning/rounds") return { round: m.start(body) };
    const reviewMatch = url.match(/^\/api\/learning\/reviews\/([^/]+)$/);
    if (reviewMatch && method === "PUT")
      return { review: m.reviewAction(reviewMatch[1], body) };
    const match = url.match(/^\/api\/learning\/rounds\/([^/]+)(?:\/(\w+))?$/);
    if (match) {
      const result = {
        round:
          method === "GET" ? m.round(match[1]) : m[match[2]](match[1], body),
      };
      if (intercept && match[2] === "checkpoint") return intercept(result);
      return result;
    }
    throw new Error("unexpected " + url);
  };
  const create = () => {
    const c = new LearningClient({
      local,
      api,
      scope: () => ({ ...state }),
      getDeck: async () => deck,
      onStatus: (s) => statuses.push(s),
    });
    t.after(() => c.detach());
    return c;
  };
  const engine = (r) => {
    const p = createPractice({ clock: () => 0 });
    p.restore(
      { id: r.scopeId, title: r.title, version: r.deckVersion, words: r.words },
      r.checkpoint,
      r.id,
    );
    return p;
  };
  return {
    local,
    state,
    calls,
    statuses,
    model,
    create,
    engine,
    set online(x) {
      online = x;
    },
    set intercept(x) {
      intercept = x;
    },
  };
}
test("Guest checkpoints and whole-deck progress survive a new client instance without becoming account data", async (t) => {
  const f = fixture(t, { guest: true, count: 31 }),
    one = f.create(),
    r = await one.start("deck"),
    p = f.engine(r);
  for (const ch of p.state.word) p.input(ch);
  p.input("z");
  one.capture(p.snapshot());
  await one.flush();
  one.detach();
  const two = f.create(),
    resumed = await two.start("deck");
  assert.equal(resumed.checkpoint.results.length, 1);
  assert.equal(resumed.checkpoint.current.mistakes, 1);
  const restored = f.engine(resumed);
  while (!restored.state.done) {
    for (const ch of restored.state.word.slice(restored.state.typed))
      restored.input(ch);
  }
  two.capture(restored.snapshot());
  await two.flush();
  const summary = await two.refresh();
  assert.equal(summary.plans[0].seen, 30);
  assert.equal(summary.reviewCount, 1);
  const next = await two.start("deck");
  assert.equal(next.words.length, 1);
  assert.equal((await two.guest("sessions")).length, 1);
  assert.equal(f.calls.length, 0);
});
test("An older upload acknowledgement cannot overwrite a newer local checkpoint", async (t) => {
  const f = fixture(t),
    client = f.create(),
    r = await client.start("deck"),
    p = f.engine(r),
    gate = deferred(),
    started = deferred();
  p.input("s");
  client.capture(p.snapshot());
  f.intercept = async (result) => {
    started.resolve();
    await gate.promise;
    return result;
  };
  const upload = client.flush();
  await started.promise;
  p.input("u");
  client.capture(p.snapshot());
  gate.resolve();
  await upload;
  let cached = await f.local.get("studyCache", "a:" + r.id);
  assert.equal(cached.sequence, 2);
  assert.equal(cached.checkpoint.current.typed, 2);
  assert.equal(cached.pending, true);
  f.intercept = null;
  await client.flush();
  cached = await f.local.get("studyCache", "a:" + r.id);
  assert.equal(cached.pending, false);
  assert.equal(f.model("a").round(r.id).checkpoint.current.typed, 2);
});
test("An offline local checkpoint resumes after reopening and uploads once when the connection returns", async (t) => {
  const f = fixture(t),
    one = f.create(),
    r = await one.start("deck"),
    p = f.engine(r);
  f.online = false;
  p.input("s");
  p.input("u");
  one.capture(p.snapshot());
  await one.flush();
  one.detach();
  const two = f.create(),
    resumed = await two.start("deck");
  assert.equal(resumed.checkpoint.current.typed, 2);
  assert.equal(resumed.generation, r.generation);
  f.online = true;
  await two.flush();
  const stored = f.model("a").round(r.id);
  assert.equal(stored.checkpoint.current.typed, 2);
  assert.equal(stored.sequence, 1);
  await two.flush();
  assert.equal(f.model("a").round(r.id).version, stored.version);
});
test("Switching accounts never reads or sends the previous account checkpoint queue", async (t) => {
  const f = fixture(t),
    client = f.create(),
    r = await client.start("deck"),
    p = f.engine(r);
  f.online = false;
  p.input("s");
  client.capture(p.snapshot());
  await client.flush();
  client.detach();
  f.state.owner = "b";
  f.state.epoch++;
  f.online = true;
  const count = f.calls.length;
  await client.flush();
  assert.equal(
    f.calls.slice(count).some((c) => c.url.endsWith("/checkpoint")),
    false,
  );
  assert.equal((await client.export()).checkpoints.length, 0);
  f.state.owner = "a";
  f.state.epoch++;
  await client.flush();
  assert.equal(f.model("a").round(r.id).checkpoint.current.typed, 1);
});
test("Local write failure retains the newest in-memory snapshot and retries without falsely acknowledging persistence", async (t) => {
  const f = fixture(t),
    client = f.create(),
    r = await client.start("deck"),
    p = f.engine(r);
  f.local.fail = true;
  p.input("s");
  client.capture(p.snapshot());
  p.input("u");
  client.capture(p.snapshot());
  await client.flush();
  assert.equal(client.memory.size, 1);
  assert.equal([...client.memory.values()][0].checkpoint.current.typed, 2);
  assert.ok(f.statuses.some((s) => s.unpersisted));
  f.local.fail = false;
  await client.flush();
  assert.equal(client.memory.size, 0);
  assert.equal(f.model("a").round(r.id).checkpoint.current.typed, 2);
});

test("A reopened offline conflict stays discoverable even if the remote round has already completed", async (t) => {
  const f = fixture(t),
    one = f.create(),
    r = await one.start("deck"),
    p = f.engine(r);
  f.online = false;
  p.input("s");
  one.capture(p.snapshot());
  await one.flush();
  one.detach();
  f.online = true;
  const remote = f
      .model("a")
      .start({ deckId: "deck", operationId: "remote-device" }),
    other = f.engine(remote);
  for (const c of "sun") other.input(c);
  f.model("a").checkpoint(remote.id, {
    generation: remote.generation,
    sequence: 1,
    checkpoint: other.snapshot(),
  });
  const two = f.create();
  await two.flush();
  const summary = await two.refresh();
  assert.equal(summary.rounds.length, 1);
  assert.equal(summary.rounds[0].id, r.id);
  assert.equal(summary.rounds[0].conflict, true);
  await assert.rejects(two.start("deck", { roundId: r.id }), /未合并/);
  const saved = await two.fork();
  assert.equal(saved.kind, "extra");
  assert.equal(saved.checkpoint.current.typed, 1);
  assert.equal(
    (await two.refresh()).rounds.some((r) => r.conflict),
    false,
  );
});

test("A queued manual mark cannot override newer practice, and a fresh explicit action replaces its stale intent", async (t) => {
  const f = fixture(t),
    client = f.create();
  const record = (id) => ({
    id,
    deckId: "deck",
    deckVersion: 1,
    title: "deck",
    createdAt: new Date().toISOString(),
    words: [
      {
        id: "w0",
        term: "sun",
        meaning: "词0",
        status: "completed",
        mistakes: 1,
      },
    ],
  });
  f.model("a").recordLegacy(record("first"));
  const entry = (await client.reviews())[0];
  f.online = false;
  await client.setReview(entry, false);
  f.model("a").recordLegacy(record("second"));
  f.online = true;
  await client.flush();
  assert.equal(f.model("a").reviews()[0].active, true);
  assert.equal(
    (await f.local.all("studyActions")).filter((a) => a.blocked).length,
    1,
  );
  await client.setReview((await client.reviews())[0], false);
  assert.equal(f.model("a").reviews()[0].active, false);
  assert.equal((await f.local.all("studyActions")).length, 0);
});
