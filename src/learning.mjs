import { LearningModel, MemoryLearningRepo } from "../shared/learning.mjs";
import { newId } from "../shared/words.mjs";
import { coalesceSync, accountChanged } from "./sync.mjs";

export class LearningClient {
  constructor({
    local,
    api,
    scope,
    getDeck,
    onStatus = () => {},
    onData = () => {},
    onConflict = () => {},
  }) {
    Object.assign(this, {
      local,
      api,
      scope,
      getDeck,
      onStatus,
      onData,
      onConflict,
    });
    this.active = null;
    this.memory = new Map();
    this.timer = null;
    this.sequence = 0;
    this.frozen = false;
    this.flush = coalesceSync((options) => this.flushData(options));
  }
  current(stamp) {
    const s = this.scope();
    return stamp.owner === s.owner && stamp.epoch === s.epoch;
  }
  detach() {
    this.active = null;
    this.frozen = false;
    clearTimeout(this.timer);
    this.timer = null;
  }
  async guest(method, ...args) {
    const current = await this.local.get("studyMeta", "guest-document");
    const legacy = current?.initialized ? [] : await this.local.all("sessions");
    let deck;
    if (
      method === "start" &&
      args[0].deckId !== "review" &&
      !/^(?:retry|extra)_/.test(args[0].deckId)
    )
      deck = await this.getDeck(args[0].deckId);
    return this.local.mutate("studyMeta", "guest-document", (doc) => {
      const repo = new MemoryLearningRepo(doc?.records || []);
      if (deck) repo.put("revision", deck.id + "@" + deck.version, deck);
      const model = new LearningModel(repo, {
        getDeck: (id, version) => {
          const value =
            version === undefined && deck?.id === id
              ? deck
              : repo.get("revision", id + "@" + version);
          if (!value) throw new Error("词库快照不可用，请重新打开词库");
          return value;
        },
      });
      if (!doc?.initialized)
        for (const record of legacy) model.recordLegacy(record);
      const result =
        method === "export" ? repo.records : model[method](...args);
      return {
        value: {
          id: "guest-document",
          initialized: true,
          records: repo.records,
        },
        result,
      };
    });
  }
  async status(error = "") {
    const stamp = this.scope();
    const cached = (await this.local.all("studyCache")).filter(
      (c) => c.ownerId === stamp.owner && c.pending,
    );
    const actions = (await this.local.all("studyActions")).filter(
      (c) => c.ownerId === stamp.owner,
    );
    const unpersisted = [...this.memory.values()].filter(
      (c) => c.ownerId === stamp.owner,
    );
    if (this.current(stamp))
      this.onStatus({
        pending: cached.length + actions.length,
        error:
          error ||
          (this.frozen ? "这轮进度已在其他设备继续，本机副本仍保留。" : "") ||
          cached.find((c) => c.error)?.error ||
          actions.find((c) => c.error)?.error ||
          "",
        unpersisted: unpersisted.length,
        blockedActions: actions.filter((a) => a.blocked),
      });
  }
  async refresh() {
    const stamp = this.scope();
    const summary =
      stamp.owner === "guest"
        ? await this.guest("summary")
        : (await this.api("/api/learning")).summary;
    if (!this.current(stamp)) throw accountChanged();
    const remoteRounds = [...summary.rounds];
    const localCopies = (await this.local.all("studyCache")).filter(
      (c) => c.ownerId === stamp.owner && c.pending,
    );
    for (const cache of localCopies) {
      const r = cache.round,
        index = summary.rounds.findIndex((s) => s.id === r.id);
      const local = {
        id: r.id,
        scopeId: r.scopeId,
        kind: r.kind,
        title: r.title,
        generation: r.generation,
        version: r.version,
        updatedAt: r.updatedAt,
        done: cache.checkpoint.results.length,
        total: r.words.length,
        local: true,
        conflict: !!cache.conflict,
      };
      if (index < 0) summary.rounds.unshift(local);
      else if (cache.conflict) summary.rounds[index] = local;
    }
    await this.local.put("studyMeta", {
      id: "summary:" + stamp.owner,
      ownerId: stamp.owner,
      summary,
    });
    if (!this.current(stamp)) throw accountChanged();
    const other = remoteRounds.find((r) => r.id === this.active?.round.id);
    if (
      other &&
      other.generation !== this.active.round.generation &&
      !this.frozen
    ) {
      this.frozen = true;
      this.onConflict(
        "这轮进度已在另一设备继续。本机副本仍保留，可另存为独立一轮。",
      );
    }
    this.onData(summary);
    await this.status();
    return summary;
  }
  async reviews() {
    const stamp = this.scope();
    const reviews =
      stamp.owner === "guest"
        ? await this.guest("reviews")
        : (await this.api("/api/learning/reviews")).reviews;
    if (!this.current(stamp)) throw accountChanged();
    return reviews;
  }
  async operation(key, payload, request) {
    const stamp = this.scope(),
      id = "operation:" + stamp.owner + ":" + key,
      input = JSON.stringify(payload);
    const operation = await this.local.mutate("studyMeta", id, (current) => {
      const value =
        current?.input === input
          ? current
          : { id, input, operationId: newId(), ownerId: stamp.owner };
      return { value, result: value };
    });
    if (!this.current(stamp)) throw accountChanged();
    try {
      const result = await request({
        ...payload,
        operationId: operation.operationId,
      });
      await this.local.remove("studyMeta", id);
      if (!this.current(stamp)) throw accountChanged();
      return result;
    } catch (error) {
      if (error.status >= 400 && error.status < 500)
        await this.local.remove("studyMeta", id);
      throw error;
    }
  }
  async install(round) {
    const stamp = this.scope(),
      cache = {
        id: stamp.owner + ":" + round.id,
        ownerId: stamp.owner,
        round,
        sequence: round.sequence,
        checkpoint: round.checkpoint,
        pending: false,
      };
    await this.local.put("studyCache", cache);
    if (!this.current(stamp)) throw accountChanged();
    this.active = cache;
    this.frozen = false;
    this.sequence = round.sequence;
    await this.status();
    return round;
  }
  async start(deckId, { restart = false, roundId, discard = false } = {}) {
    const stamp = this.scope();
    await this.flush();
    if (!this.current(stamp)) throw accountChanged();
    const localCopies = (await this.local.all("studyCache")).filter(
      (c) => c.ownerId === stamp.owner,
    );
    const cached = roundId
      ? localCopies.find((c) => c.round.id === roundId)
      : localCopies
          .filter(
            (c) => c.round.scopeId === deckId && c.round.status === "active",
          )
          .sort((a, b) =>
            b.round.updatedAt.localeCompare(a.round.updatedAt),
          )[0];
    if (cached?.conflict && !discard) {
      this.active = cached;
      this.sequence = cached.sequence;
      this.frozen = true;
      this.onConflict(cached.error);
      throw new Error("本机有未合并的进度，请先选择载入最新或另存本机副本。");
    }
    if (cached?.pending && !discard && !cached.conflict) {
      // An offline continuation uses the same claim; it never impersonates a fresh server claim.
      this.active = cached;
      this.sequence = cached.sequence;
      this.frozen = false;
      await this.status();
      return { ...cached.round, checkpoint: cached.checkpoint };
    }
    try {
      let round;
      if (roundId) {
        const existing =
          stamp.owner === "guest"
            ? await this.guest("round", roundId)
            : (await this.api("/api/learning/rounds/" + roundId)).round;
        if (existing.status !== "active") return this.install(existing);
        round = await this.operation(
          "claim:" + roundId,
          { version: existing.version },
          (body) =>
            stamp.owner === "guest"
              ? this.guest("claim", roundId, body)
              : this.api("/api/learning/rounds/" + roundId + "/claim", {
                  method: "POST",
                  body,
                }).then((r) => r.round),
        );
      } else {
        round = await this.operation(
          "start:" + deckId,
          { deckId, restart },
          (body) =>
            stamp.owner === "guest"
              ? this.guest("start", body)
              : this.api("/api/learning/rounds", { method: "POST", body }).then(
                  (r) => r.round,
                ),
        );
      }
      if (!this.current(stamp)) throw accountChanged();
      if (restart && cached)
        await this.local.put("studyCache", {
          ...cached,
          pending: false,
          round: { ...cached.round, status: "archived" },
        });
      return await this.install(round);
    } catch (error) {
      if (error.status === 0 && cached && !restart && !discard) {
        this.active = cached;
        this.sequence = cached.sequence;
        this.frozen = false;
        await this.status("离线续练中，进度先保存在此浏览器。");
        return { ...cached.round, checkpoint: cached.checkpoint };
      }
      throw error;
    }
  }
  async retry(wordIds) {
    await this.flush();
    const id = this.active?.round.id;
    if (!id) throw new Error("请先完成一轮练习");
    const who = this.scope().owner;
    const round = await this.operation("retry:" + id, { wordIds }, (body) =>
      who === "guest"
        ? this.guest("retry", id, body)
        : this.api("/api/learning/rounds/" + id + "/retry", {
            method: "POST",
            body,
          }).then((r) => r.round),
    );
    return this.install(round);
  }
  async fork() {
    const cached = this.active;
    if (!cached) throw new Error("没有可保留的本机进度");
    const who = this.scope().owner;
    const round = await this.operation(
      "fork:" + cached.round.id,
      { checkpoint: cached.checkpoint },
      (body) =>
        who === "guest"
          ? this.guest("fork", cached.round.id, body)
          : this.api("/api/learning/rounds/" + cached.round.id + "/fork", {
              method: "POST",
              body,
            }).then((r) => r.round),
    );
    await this.local.put("studyCache", {
      ...cached,
      pending: false,
      conflict: false,
      round: { ...cached.round, status: "archived" },
    });
    return this.install(round);
  }
  capture(checkpoint) {
    if (!this.active || this.frozen) return;
    const stamp = this.scope(),
      sequence = ++this.sequence;
    const cache = {
      ...this.active,
      sequence,
      checkpoint: structuredClone(checkpoint),
      pending: true,
      error: "",
      round: { ...this.active.round, updatedAt: new Date().toISOString() },
    };
    this.active = cache;
    this.memory.set(cache.id, cache);
    this.onStatus({ pending: 1, error: "", unpersisted: 0 });
    this.persist(cache).catch((error) => {
      if (this.current(stamp))
        this.onStatus({
          pending: 0,
          error: error.message,
          unpersisted: this.memory.size,
        });
    });
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush().catch((error) =>
          this.onStatus({ pending: 1, error: error.message, unpersisted: 0 }),
        );
      }, 1000);
  }
  async persist(cache) {
    await this.local.mutate("studyCache", cache.id, (current) => {
      const newer =
        current &&
        (current.round.generation > cache.round.generation ||
          (current.round.generation === cache.round.generation &&
            current.sequence > cache.sequence));
      return { value: newer ? current : cache, result: null };
    });
    if (
      this.memory.get(cache.id)?.sequence === cache.sequence &&
      this.memory.get(cache.id)?.round.generation === cache.round.generation
    )
      this.memory.delete(cache.id);
  }
  async flushData({ retryBlocked = false } = {}) {
    const stamp = this.scope();
    try {
      for (const cache of this.memory.values())
        if (cache.ownerId === stamp.owner) await this.persist(cache);
      const cached = (await this.local.all("studyCache")).filter(
        (c) => c.ownerId === stamp.owner && c.pending,
      );
      for (const sent of cached) {
        if (!this.current(stamp)) return;
        if (sent.conflict || (sent.blocked && !retryBlocked)) continue;
        try {
          const payload = {
            generation: sent.round.generation,
            sequence: sent.sequence,
            checkpoint: sent.checkpoint,
          };
          const round =
            stamp.owner === "guest"
              ? await this.guest("checkpoint", sent.round.id, payload)
              : (
                  await this.api(
                    "/api/learning/rounds/" + sent.round.id + "/checkpoint",
                    {
                      method: "POST",
                      body: payload,
                      expectedOwner: stamp.owner,
                    },
                  )
                ).round;
          await this.local.mutate("studyCache", sent.id, (current) => {
            const same =
              current?.round.generation === sent.round.generation &&
              current?.sequence === sent.sequence;
            const value = same
              ? {
                  ...current,
                  round,
                  checkpoint: round.checkpoint,
                  sequence: round.sequence,
                  pending: false,
                  blocked: false,
                  error: "",
                }
              : current;
            return { value, result: null };
          });
          if (
            this.current(stamp) &&
            this.active?.id === sent.id &&
            this.active.sequence === sent.sequence
          )
            this.active = {
              ...sent,
              round,
              checkpoint: round.checkpoint,
              pending: false,
              error: "",
            };
        } catch (error) {
          if (error.code === "STALE_ACCOUNT") return;
          const conflict = error.status === 409;
          await this.local.mutate("studyCache", sent.id, (current) => ({
            value: {
              ...current,
              error: error.message,
              conflict,
              blocked:
                conflict ||
                (error.status >= 400 &&
                  error.status < 500 &&
                  ![401, 429].includes(error.status)),
            },
            result: null,
          }));
          if (conflict && this.current(stamp) && this.active?.id === sent.id) {
            this.frozen = true;
            this.onConflict(error.message);
          }
          break;
        }
      }
      const actions = (await this.local.all("studyActions")).filter(
        (a) => a.ownerId === stamp.owner,
      );
      for (const action of actions) {
        if (!this.current(stamp)) return;
        if (action.blocked && !retryBlocked) continue;
        try {
          if (stamp.owner === "guest")
            await this.guest("reviewAction", action.reviewId, action.body);
          else
            await this.api("/api/learning/reviews/" + action.reviewId, {
              method: "PUT",
              body: action.body,
              expectedOwner: stamp.owner,
            });
          await this.local.remove("studyActions", action.id);
        } catch (error) {
          if (error.code === "STALE_ACCOUNT") return;
          await this.local.put("studyActions", {
            ...action,
            error: error.message,
            blocked:
              error.status >= 400 &&
              error.status < 500 &&
              ![401, 429].includes(error.status),
          });
          break;
        }
      }
      if (this.current(stamp)) {
        await this.status();
        if (cached.length || actions.length) await this.refresh();
      }
    } catch (error) {
      if (this.current(stamp) && error.code !== "STALE_ACCOUNT")
        this.onStatus({
          pending: 1,
          error: error.message,
          unpersisted: this.memory.size,
        });
    }
  }
  async setReview(entry, active) {
    const stamp = this.scope(),
      ownerId = stamp.owner,
      operationId = newId();
    for (const old of await this.local.all("studyActions"))
      if (old.ownerId === ownerId && old.reviewId === entry.id && old.blocked)
        await this.local.remove("studyActions", old.id);
    if (!this.current(stamp)) throw accountChanged();
    await this.local.put("studyActions", {
      id: ownerId + ":" + operationId,
      ownerId,
      reviewId: entry.id,
      body: { operationId, version: entry.version, active },
    });
    await this.flush();
    if (!this.current(stamp)) throw accountChanged();
  }
  async clearReviewConflicts() {
    const stamp = this.scope();
    for (const action of await this.local.all("studyActions"))
      if (action.ownerId === stamp.owner && action.blocked)
        await this.local.remove("studyActions", action.id);
    if (this.current(stamp)) await this.status();
  }
  async export() {
    const stamp = this.scope();
    const checkpoints = (await this.local.all("studyCache")).filter(
      (c) => c.ownerId === stamp.owner,
    );
    const actions = (await this.local.all("studyActions")).filter(
      (c) => c.ownerId === stamp.owner,
    );
    const memory = [...this.memory.values()].filter(
      (c) => c.ownerId === stamp.owner,
    );
    if (!this.current(stamp)) throw accountChanged();
    return {
      checkpoints,
      actions,
      unpersisted: memory,
      guest: stamp.owner === "guest" ? await this.guest("export") : undefined,
    };
  }
}
