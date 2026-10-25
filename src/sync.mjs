export const accountOwner = (state) => state.user?.id || "guest";
export const accountStamp = (state) => ({
  owner: accountOwner(state),
  epoch: state.epoch,
});
export const accountCurrent = (state, stamp) =>
  stamp.owner === accountOwner(state) && stamp.epoch === state.epoch;

export function accountChanged() {
  return Object.assign(new Error("账号状态已变化，请在当前账号下重试"), {
    code: "STALE_ACCOUNT",
  });
}

// Every response belongs to the account generation which issued it, not to
// whichever account happens to be on screen when the response arrives.
export function createAPI({
  state,
  fetcher = fetch,
  onIdentityChange,
  messages = {},
}) {
  return async function api(
    url,
    { method = "GET", body, expectedOwner = accountOwner(state) } = {},
  ) {
    const stamp = accountStamp(state);
    if (expectedOwner !== stamp.owner) throw accountChanged();
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (
      expectedOwner !== "guest" &&
      url !== "/api/me" &&
      !/^\/api\/auth\/sign-(?:in|up)\//.test(url)
    )
      headers["X-Keyword-User"] = expectedOwner;
    let response;
    try {
      response = await fetcher(url, {
        method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      if (!accountCurrent(state, stamp)) throw accountChanged();
      throw Object.assign(
        new Error("无法连接服务，内容未确认保存。请检查网络后重试。"),
        { status: 0 },
      );
    }
    let data;
    try {
      data = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error();
    } catch {
      if (!accountCurrent(state, stamp)) throw accountChanged();
      throw Object.assign(new Error("服务响应不完整，尚未确认保存。请重试。"), {
        status: response.ok ? 502 : response.status,
      });
    }
    if (!accountCurrent(state, stamp)) throw accountChanged();
    if (!response.ok) {
      if (
        ["ACCOUNT_CHANGED", "SESSION_EXPIRED"].includes(data.code) ||
        (data.code === "LOGIN_REQUIRED" && expectedOwner !== "guest")
      )
        onIdentityChange?.();
      throw Object.assign(
        new Error(
          messages[data.code] ||
            data.error?.message ||
            data.error ||
            data.message ||
            "请求失败，请重试",
        ),
        { status: response.status, code: data.code },
      );
    }
    return data;
  };
}

// Coalesce concurrent polls, but run another pass if auth or data changed during
// the current pass. Callers never mistake an already-running refresh for success.
export function coalesceSync(run) {
  let running, next;
  return (options = {}) => {
    next = {
      identity: (next?.identity ?? false) || options.identity !== false,
      retryBlocked: !!next?.retryBlocked || !!options.retryBlocked,
    };
    if (!running) {
      running = (async () => {
        while (next) {
          const options = next;
          next = null;
          await run(options);
        }
      })().finally(() => {
        running = null;
      });
    }
    return running;
  };
}

export async function flushAccountOutbox({
  local,
  ownerId,
  isCurrent,
  send,
  retryBlocked = false,
}) {
  const items = (await local.all("outbox")).filter(
    (x) => x.ownerId === ownerId,
  );
  for (const item of items) {
    if (!isCurrent()) break;
    if (item.state === "blocked" && !retryBlocked) continue;
    try {
      await send(item.result);
      await local.remove("outbox", item.id);
    } catch (error) {
      if (error.code === "STALE_ACCOUNT") break;
      item.error = error.message;
      item.state =
        error.status >= 400 &&
        error.status < 500 &&
        ![401, 409, 429].includes(error.status)
          ? "blocked"
          : "pending";
      await local.put("outbox", item);
      break;
    }
  }
  const pending = (await local.all("outbox")).filter(
    (x) => x.ownerId === ownerId,
  );
  return { pending, error: pending.find((x) => x.error)?.error || "" };
}
