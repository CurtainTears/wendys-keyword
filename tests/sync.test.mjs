import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAPI,
  coalesceSync,
  flushAccountOutbox,
  accountStamp,
  accountCurrent,
} from "../src/sync.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const ok = (data) => Response.json(data);
const fail = (code, status) => Response.json({ code, error: code }, { status });
function memoryLocal(items) {
  const data = new Map(items.map((x) => [x.id, structuredClone(x)]));
  return {
    all: async () => [...data.values()].map((x) => structuredClone(x)),
    put: async (_, item) => data.set(item.id, structuredClone(item)),
    remove: async (_, id) => data.delete(id),
  };
}
const item = (ownerId, id) => ({
  ownerId,
  id: ownerId + ":" + id,
  result: { id },
  state: "pending",
});

test("A response from an old account generation is discarded, even after switching back to the same user", async () => {
  const state = { user: { id: "a" }, epoch: 0 };
  const pending = deferred();
  const api = createAPI({ state, fetcher: () => pending.promise });
  const request = api("/api/decks");
  state.epoch += 2; // A -> B -> A
  pending.resolve(ok({ decks: ["private A"] }));
  await assert.rejects(request, { code: "STALE_ACCOUNT" });
});
test("Every private read and sensitive auth mutation carries its expected owner; login and identity discovery do not", async () => {
  const state = { user: { id: "a" }, epoch: 0 },
    calls = [];
  const api = createAPI({
    state,
    fetcher: async (url, options) => {
      calls.push([url, options]);
      return ok({});
    },
  });
  for (const url of [
    "/api/decks",
    "/api/sessions",
    "/api/export",
    "/api/auth/sign-out",
    "/api/auth/change-password",
    "/api/me",
    "/api/auth/sign-in/email",
    "/api/auth/sign-up/email",
  ])
    await api(url);
  assert.deepEqual(
    calls.map(([, x]) => x.headers["X-Keyword-User"]),
    ["a", "a", "a", "a", "a", undefined, undefined, undefined],
  );
  assert.ok(
    calls.every(
      ([, x]) => x.cache === "no-store" && x.credentials === "same-origin",
    ),
  );
  await assert.rejects(api("/api/decks", { expectedOwner: "b" }), {
    code: "STALE_ACCOUNT",
  });
});
test("Expired or changed sessions trigger identity revalidation; edit conflicts do not log the user out", async () => {
  const state = { user: { id: "a" }, epoch: 0 };
  let changes = 0,
    code = "ACCOUNT_CHANGED";
  const api = createAPI({
    state,
    onIdentityChange: () => changes++,
    fetcher: async () => fail(code, code === "SESSION_EXPIRED" ? 401 : 409),
  });
  await assert.rejects(api("/api/decks"), { code: "ACCOUNT_CHANGED" });
  code = "SESSION_EXPIRED";
  await assert.rejects(api("/api/decks"), { code: "SESSION_EXPIRED" });
  code = "EDIT_CONFLICT";
  await assert.rejects(api("/api/decks"), { code: "EDIT_CONFLICT" });
  assert.equal(changes, 2);
});
test("A stale failed request cannot trigger logout or overwrite the next account's state", async () => {
  const state = { user: { id: "a" }, epoch: 0 },
    gate = deferred();
  let changed = false;
  const api = createAPI({
    state,
    onIdentityChange: () => (changed = true),
    fetcher: () => gate.promise,
  });
  const request = api("/api/decks");
  state.user = { id: "b" };
  state.epoch++;
  gate.resolve(fail("SESSION_EXPIRED", 401));
  await assert.rejects(request, { code: "STALE_ACCOUNT" });
  assert.equal(changed, false);
});
test("A malformed success response is a retryable failure, never confirmation that a record was saved", async () => {
  const state = { user: { id: "a" }, epoch: 0 };
  for (const response of [
    new Response("<html>proxy error</html>"),
    Response.json(null),
    Response.json([]),
  ]) {
    const api = createAPI({ state, fetcher: async () => response });
    await assert.rejects(api("/api/sessions", { method: "POST", body: {} }), {
      status: 502,
    });
  }
});
test("Refresh requests coalesce but changes during a refresh always receive a second identity-aware pass", async () => {
  const gate = deferred(),
    calls = [];
  const sync = coalesceSync(async (options) => {
    calls.push(options);
    if (calls.length === 1) await gate.promise;
  });
  const first = sync({ identity: false });
  const second = sync({ retryBlocked: true });
  const third = sync({ identity: false });
  assert.equal(first, second);
  assert.equal(second, third);
  gate.resolve();
  await first;
  assert.deepEqual(calls, [
    { identity: false, retryBlocked: false },
    { identity: true, retryBlocked: true },
  ]);
  await sync();
  assert.equal(calls.length, 3);
});
test("Offline results stay in their owner's queue and retry once without submitting another account's records", async () => {
  const local = memoryLocal([
    item("a", "one"),
    item("a", "two"),
    item("b", "private"),
  ]);
  const sent = [];
  let online = false;
  const options = {
    local,
    ownerId: "a",
    isCurrent: () => true,
    send: async (result) => {
      if (!online) throw Object.assign(new Error("offline"), { status: 0 });
      sent.push(result.id);
    },
  };
  const failed = await flushAccountOutbox(options);
  assert.equal(failed.pending.length, 2);
  assert.equal(failed.error, "offline");
  online = true;
  assert.deepEqual((await flushAccountOutbox(options)).pending, []);
  await flushAccountOutbox(options);
  assert.deepEqual(sent, ["one", "two"]);
  assert.deepEqual(
    (await local.all("outbox")).map((x) => x.ownerId),
    ["b"],
  );
});
test("A switch while uploading stops the old account's remaining queue", async () => {
  const state = { user: { id: "a" }, epoch: 0 },
    stamp = accountStamp(state);
  const local = memoryLocal([
    item("a", "one"),
    item("a", "two"),
    item("b", "three"),
  ]);
  const sent = [];
  await flushAccountOutbox({
    local,
    ownerId: "a",
    isCurrent: () => accountCurrent(state, stamp),
    send: async (record) => {
      sent.push(record.id);
      state.user = { id: "b" };
      state.epoch++;
    },
  });
  assert.deepEqual(sent, ["one"]);
  assert.deepEqual(
    (await local.all("outbox")).map((x) => x.result.id),
    ["two", "three"],
  );
});
test("Rejected data is retained, not retried forever, and remains explicitly retryable", async () => {
  const local = memoryLocal([item("a", "one")]);
  let attempts = 0,
    valid = false;
  const options = {
    local,
    ownerId: "a",
    isCurrent: () => true,
    send: async () => {
      attempts++;
      if (!valid)
        throw Object.assign(new Error("invalid data"), { status: 400 });
    },
  };
  const result = await flushAccountOutbox(options);
  assert.equal(result.pending[0].state, "blocked");
  assert.equal((await flushAccountOutbox(options)).error, "invalid data");
  assert.equal(attempts, 1);
  valid = true;
  assert.deepEqual(
    (await flushAccountOutbox({ ...options, retryBlocked: true })).pending,
    [],
  );
});
