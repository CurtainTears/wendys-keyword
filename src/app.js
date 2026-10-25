import "./trainer.css";
import "./app.css";
import { createTrainer } from "./trainer.js";
import { local } from "./local.mjs";
import { LearningClient } from "./learning.mjs";
import {
  accountOwner,
  accountStamp,
  accountCurrent,
  accountChanged,
  createAPI,
  coalesceSync,
  flushAccountOutbox,
} from "./sync.mjs";
import {
  parseImport,
  validateDeck,
  mergeWords,
  newId,
  exportCSV,
  exportTXT,
  MAX_WORDS,
  makeBackup,
} from "../shared/words.mjs";

const $ = (id) => document.getElementById(id);
const state = {
  user: null,
  known: false,
  epoch: 0,
  mine: [],
  trash: [],
  catalog: [],
  sessions: [],
  learning: { rounds: [], plans: [], reviewCount: 0, masteredCount: 0 },
  learningPending: 0,
  learningError: "",
  learningUnpersisted: 0,
  reviews: [],
  reviewFilter: "active",
  reviewPage: 0,
  starting: false,
  historyError: false,
  view: "library",
  filter: "all",
  selected: null,
  wordPage: 0,
  busy: 0,
  syncError: "",
  outboxError: "",
  syncedAt: null,
  refreshing: false,
  authMode: "login",
  editor: null,
  editorPage: 0,
  importPreview: null,
  migration: null,
  pending: [],
  invitations: [],
  invitePage: 0,
  revokeInvite: null,
};
const owner = () => accountOwner(state);
const unpersistedResults = new Map();
const trainer = createTrainer({
  onComplete: savePractice,
  onRestart: () => safe(restartPractice),
  onWrong: (ids) => safe(() => retryWrong(ids)),
  onCheckpoint: saveCheckpoint,
  onPreferences: savePreferences,
});
let practiceOwner = "guest";
function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}
function button(label, handler, className = "text-button") {
  const b = node("button", className, label);
  b.type = "button";
  b.addEventListener("click", () => safe(handler));
  return b;
}
function message(text, error = false) {
  $("globalMessage").textContent = text;
  $("globalMessage").classList.toggle("error", error);
  $("globalMessage").hidden = !text;
}
function errorText(error) {
  return error?.message || "操作失败，请重试";
}
async function safe(fn) {
  try {
    await fn();
  } catch (error) {
    if (error.code !== "STALE_ACCOUNT") message(errorText(error), true);
  }
}
function assertReady(expected = owner(), epoch = state.epoch) {
  if (!state.known) throw new Error("账号状态尚未确认，请先点击右上角重试连接");
  if (!state.user) throw new Error("请先登录后使用词库和练习");
  if (expected !== owner() || epoch !== state.epoch) throw accountChanged();
}
const authMessages = {
  INVALID_EMAIL_OR_PASSWORD: "邮箱或密码不正确",
  INVALID_PASSWORD: "当前密码不正确",
  USER_ALREADY_EXISTS: "该邮箱已有账号，请直接登录",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "该邮箱已有账号，请直接登录",
  PASSWORD_TOO_SHORT: "密码至少 10 位",
  INVITE_REQUIRED: "注册需要邀请码，请联系管理员获取。",
  INVITE_INVALID: "邀请码无效、已使用或已失效，请联系管理员。",
  TOO_MANY_REQUESTS: "尝试过于频繁，请稍后再试",
};
const api = createAPI({
  state,
  onIdentityChange: invalidateIdentity,
  messages: authMessages,
});
const learning = new LearningClient({
  local,
  api,
  getDeck,
  scope: () => ({ owner: owner(), epoch: state.epoch }),
  onStatus: (status) => {
    state.learningPending = status.pending;
    state.learningError = status.error;
    state.learningUnpersisted = status.unpersisted;
    $("reviewActionConflict").hidden = !status.blockedActions?.length;
    $("reviewActionConflictText").textContent = status.blockedActions?.length
      ? `有 ${status.blockedActions.length} 个标记尚未执行：${status.blockedActions[0].error}。可按最新状态重新操作，或清除这些未执行的标记。`
      : "";
    $("checkpointStatus").textContent = status.unpersisted
      ? "本机进度尚未保存，请保留页面，重试或导出数据。"
      : status.pending
        ? "学习状态已保存在本机 · 等待同步"
        : status.error ||
          (state.user ? "学习进度已同步到账号" : "学习进度保存在此浏览器");
    $("checkpointStatus").classList.toggle(
      "error",
      !!status.error || !!status.unpersisted,
    );
    if (trainer.state.done && learning.active)
      $("sessionSaveStatus").textContent = status.pending
        ? "本轮已保存在本机，等待同步。"
        : status.error ||
          (state.user ? "本轮已同步到账号。" : "本轮记录已保存在此浏览器。");
    syncLabel();
  },
  onData: (summary) => {
    state.learning = summary;
    $("reviewNavCount").textContent = summary.reviewCount;
    $("reviewNavCount").hidden = !summary.reviewCount;
    if (!learning.frozen)
      $("btnAgain").disabled =
        trainer.state.done &&
        learning.active?.round.kind === "review" &&
        !summary.reviewCount;
    if (state.view === "library") renderLibrary();
    if (state.view === "detail") renderDetailProgress();
    renderResumeList();
  },
  onConflict: (text) => {
    trainer.setBlocked(true);
    $("checkpointConflict").hidden = false;
    $("checkpointConflictText").textContent = text;
  },
});
async function busy(buttonNode, label, fn, errorNode) {
  const text = buttonNode.textContent;
  buttonNode.disabled = true;
  buttonNode.textContent = label;
  state.busy++;
  const stamp = accountStamp(state);
  syncLabel();
  if (errorNode) errorNode.textContent = "";
  try {
    await fn();
  } catch (error) {
    if (error.code !== "STALE_ACCOUNT" && accountCurrent(state, stamp)) {
      if (errorNode) errorNode.textContent = errorText(error);
      else message(errorText(error), true);
    }
  } finally {
    state.busy--;
    buttonNode.disabled = false;
    buttonNode.textContent = text;
    syncLabel();
  }
}
function syncLabel() {
  const sync = $("syncButton");
  const issue = state.syncError || state.outboxError || state.learningError;
  const unpersisted =
    [...unpersistedResults.values()].filter((x) => x.ownerId === owner())
      .length + state.learningUnpersisted;
  const pendingCount = state.pending.length + state.learningPending;
  sync.classList.toggle("error", !!issue || !!unpersisted);
  sync.textContent = state.busy
    ? "正在处理…"
    : unpersisted
      ? `${unpersisted} 轮未保存 · 重试`
      : pendingCount
        ? `${pendingCount} 项待同步 · 重试`
        : issue
          ? "连接或同步失败 · 重试"
          : !state.known
            ? "正在确认账号…"
            : state.refreshing
              ? "正在同步…"
              : state.user
                ? state.syncedAt
                  ? "账号数据已同步"
                  : "点击同步账号数据"
                : "请先登录";
  sync.title =
    issue ||
    (state.syncedAt
      ? `上次同步：${state.syncedAt.toLocaleTimeString("zh-CN")}，点击检查更新`
      : "刷新并重试同步");
  $("accountButton").textContent = state.user ? state.user.name : "登录同步";
  $("storageFooter").textContent = state.user
    ? "账号词库默认私有 · 连接同一服务即可跨设备使用"
    : "登录后访问个人词库与练习进度";
  const unlocked = state.known && !!state.user;
  $("authGate").hidden = unlocked;
  $("mainContent").hidden = !unlocked;
  $("mainNav").hidden = !unlocked;
  $("accountArea").hidden = !unlocked;
  $("adminNav").hidden = state.user?.role !== "admin";
  $("authConnectionStatus").textContent = !unlocked ? state.syncError : "";
  $("authRetryButton").hidden = unlocked || !state.syncError;
}
function showDialog(id) {
  trainer.pause();
  if (id === "authDialog") {
    $("authEmail").focus();
    return;
  }
  if (!$(id).open) $(id).showModal();
}
function closeDialog(id) {
  if (id !== "authDialog") $(id).close();
  if (id === "revokeInviteDialog") state.revokeInvite = null;
  if (id === "editorDialog") {
    state.editor = null;
    $("editorRows").replaceChildren();
  }
  if (id === "authDialog") {
    $("authPassword").value = "";
    $("inviteCode").value = "";
  }
  if (id === "profileDialog") {
    $("currentPassword").value = "";
    $("newPassword").value = "";
  }
  if (state.view === "practice" && !document.querySelector("dialog[open]"))
    trainer.resume();
}
for (const b of document.querySelectorAll("[data-close]"))
  b.addEventListener("click", () => {
    const id = b.dataset.close;
    if (
      id === "editorDialog" &&
      editorDirty() &&
      !confirm("放弃尚未保存的词库编辑？")
    )
      return;
    closeDialog(id);
  });
for (const d of document.querySelectorAll("dialog"))
  d.addEventListener("cancel", (e) => {
    e.preventDefault();
    if (
      d.id === "editorDialog" &&
      editorDirty() &&
      !confirm("放弃尚未保存的词库编辑？")
    )
      return;
    closeDialog(d.id);
  });
function clearPrivateViews() {
  learning.detach();
  state.learning = { rounds: [], plans: [], reviewCount: 0, masteredCount: 0 };
  state.reviews = [];
  state.learningPending = 0;
  state.learningError = "";
  state.learningUnpersisted = 0;
  $("reviewList").replaceChildren();
  $("resumeList").replaceChildren();
  $("resumePanel").hidden = true;
  $("detailProgress").replaceChildren();
  $("detailProgress").hidden = true;
  $("reviewNavCount").hidden = true;
  $("reviewSearch").value = "";
  $("reviewActiveCount").textContent = "0";
  $("reviewMasteredCount").textContent = "0";
  state.reviewFilter = "active";
  state.reviewPage = 0;
  $("reviewFeedback").textContent = "";
  $("reviewActionConflict").hidden = true;
  $("reviewActionConflictText").textContent = "";
  $("checkpointConflict").hidden = true;
  $("checkpointStatus").textContent = "";
  state.selected = null;
  state.sessions = [];
  state.historyError = false;
  state.mine = [];
  state.trash = [];
  state.catalog = [];
  clearAdminView();
  state.editor = null;
  state.importPreview = null;
  state.migration = null;
  state.importOperation = null;
  $("guestMigration").hidden = true;
  $("deckGrid").replaceChildren();
  $("deckSearch").value = "";
  $("wordSearch").value = "";
  for (const id of [
    "profileName",
    "profileEmail",
    "editorError",
    "importError",
    "profileError",
    "authError",
    "migrationText",
    "historySubtitle",
    "practiceDeckName",
  ])
    if ($(id)) $(id).textContent = "";
  for (const id of [
    "currentPassword",
    "newPassword",
    "authPassword",
    "inviteCode",
    "authName",
    "authEmail",
  ])
    $(id).value = "";
  $("importTarget").replaceChildren();
  $("wordRows").replaceChildren();
  $("historyList").replaceChildren();
  $("editorRows").replaceChildren();
  $("detailTitle").textContent = "";
  $("detailDescription").textContent = "";
  $("detailSource").replaceChildren();
  $("detailSource").hidden = true;
  $("editTitle").value = "";
  $("editDescription").value = "";
  $("importText").value = "";
  $("importPreview").replaceChildren();
  $("sessionSaveStatus").textContent = "";
  trainer.reset();
  trainer.setBlocked(false);
  $("word").replaceChildren();
  $("cn").textContent = "";
  $("wlist").replaceChildren();
  $("dList").replaceChildren();
  $("done").classList.remove("on");
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
}
function adoptUser(user) {
  if ((user?.id || "guest") !== owner()) {
    state.epoch++;
    clearPrivateViews();
    state.filter = "all";
    state.pending = [];
    state.outboxError = "";
    state.syncedAt = null;
  }
  state.user = user;
  state.known = true;
  if (user?.role !== "admin") {
    clearAdminView();
    if (state.view === "admin") navigate("library");
  }
  syncLabel();
}
function invalidateIdentity() {
  state.epoch++;
  clearPrivateViews();
  state.user = null;
  state.known = false;
  state.filter = "all";
  state.pending = [];
  state.syncedAt = null;
  state.outboxError = "";
  navigate("library");
  message("账号状态已变化，正在重新确认。", true);
  syncLabel();
  safe(() => synchronize());
}
const identityChannel =
  typeof BroadcastChannel === "function"
    ? new BroadcastChannel("keyword-identity")
    : null;
identityChannel?.addEventListener("message", (event) => {
  if (event.data?.type !== "session-changed") return;
  if (event.data.owner !== owner()) invalidateIdentity();
  else safe(() => synchronize());
});
function announceIdentity() {
  identityChannel?.postMessage({ type: "session-changed", owner: owner() });
}
const refresh = coalesceSync(refreshData);
async function refreshData({ identity = true } = {}) {
  state.refreshing = true;
  const previousOwner = owner(),
    hadIdentity = state.known;
  let stamp = accountStamp(state);
  syncLabel();
  try {
    if (identity) adoptUser((await api("/api/me")).user);
    stamp = accountStamp(state);
    if (!state.user) {
      state.catalog = [];
      state.mine = [];
      state.trash = [];
      state.syncError = "";
      document.title = "KeyWord · 登录";
      return;
    }
    const who = stamp.owner,
      epoch = stamp.epoch;
    const [catalog, mine, trash] = await Promise.all([
      api("/api/catalog"),
      state.user
        ? api("/api/decks")
        : local
            .all("decks")
            .then((ds) => ({ decks: ds.filter((d) => !d.deletedAt) })),
      state.user
        ? api("/api/decks?trash=1")
        : local
            .all("decks")
            .then((ds) => ({ decks: ds.filter((d) => d.deletedAt) })),
    ]);
    if (epoch !== state.epoch || who !== owner()) return;
    state.catalog = catalog.decks;
    state.mine = mine.decks;
    state.trash = trash.decks;
    if (state.syncError && $("globalMessage").textContent === state.syncError)
      message("");
    state.syncError = "";
    await checkMigration(stamp);
    if (!accountCurrent(state, stamp)) return;
    renderLibrary();
    if (hadIdentity && previousOwner !== owner()) navigate("library");
    if (
      state.view === "detail" &&
      state.selected &&
      !document.querySelector("dialog[open]")
    ) {
      const meta = [...state.mine, ...state.catalog].find(
        (d) => d.id === state.selected.id,
      );
      if (!meta) {
        state.selected = null;
        navigate("library");
        message("词库已移入回收站或不再可访问。");
      } else if (meta.version !== state.selected.version) {
        const d = await getDeck(meta.id);
        if (!accountCurrent(state, stamp)) return;
        state.selected = d;
        renderDetail();
        message("已载入另一个设备更新后的词库。");
      }
    }
    state.syncedAt = new Date();
    if (
      identity &&
      ((hadIdentity && previousOwner !== owner()) ||
        $("globalMessage").textContent === "账号状态已变化，正在重新确认。")
    )
      message(
        state.user
          ? "账号已切换，只显示当前账号的数据。"
          : "登录已结束，请重新登录；待同步记录仍保留在原账号下。",
      );
  } catch (error) {
    if (error.code !== "STALE_ACCOUNT" && accountCurrent(state, stamp)) {
      state.syncError = errorText(error);
      message(state.syncError, true);
    }
  } finally {
    state.refreshing = false;
    syncLabel();
  }
}
function navigate(view, { hash = true } = {}) {
  if (!state.user) {
    trainer.pause();
    syncLabel();
    document.title = "KeyWord · 登录";
    return;
  }
  if (view === "admin" && state.user.role !== "admin") {
    view = "library";
    message("仅管理员可访问邀请码管理。", true);
  }
  if (state.view !== view && !state.syncError) message("");
  if (state.view === "practice" && view !== "practice") trainer.pause();
  state.view = view;
  for (const id of [
    "library",
    "detail",
    "practice",
    "review",
    "history",
    "admin",
  ])
    $(id + "View").hidden = id !== view;
  document.querySelectorAll("[data-view]").forEach((b) => {
    const active = b.dataset.view === (view === "detail" ? "library" : view);
    b.classList.toggle("active", active);
    if (active) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  if (hash)
    history.replaceState(
      null,
      "",
      "#" +
        (view === "detail" && state.selected
          ? "deck/" + state.selected.id
          : view),
    );
  if (view === "library") renderLibrary();
  if (view === "history") safe(loadHistory);
  if (view === "review") safe(loadReviews);
  if (view === "admin") safe(loadInvitations);
  if (view === "practice") renderResumeList();
  if (view === "practice") trainer.resume();
  document.title = `KeyWord · ${{ library: $("libraryHeading").textContent, detail: state.selected?.title, practice: "打字练习", review: "我的错词", history: "练习记录", admin: "邀请码管理" }[view]}`;
  window.scrollTo(0, 0);
}
for (const b of document.querySelectorAll("[data-view]"))
  b.addEventListener("click", () => navigate(b.dataset.view));
window.addEventListener("hashchange", () => safe(route));
async function route() {
  if (!state.user) return navigate("library", { hash: false });
  const hash = location.hash.slice(1);
  if (hash.startsWith("deck/")) await openDeck(hash.slice(5));
  else
    navigate(
      ["practice", "review", "history", "admin"].includes(hash)
        ? hash
        : "library",
    );
}
function paginate(container, total, page, change, size = 40) {
  container.replaceChildren();
  const pages = Math.ceil(total / size);
  if (pages <= 1) return;
  const prev = button("上一页", () => change(page - 1), ""),
    next = button("下一页", () => change(page + 1), "");
  prev.disabled = page === 0;
  next.disabled = page >= pages - 1;
  container.append(prev, node("span", "", `${page + 1} / ${pages}`), next);
}
function renderLibrary() {
  $("mineCount").textContent = state.mine.length;
  $("allCount").textContent = state.mine.length + state.catalog.length;
  $("libraryHeading").textContent =
    state.filter === "all"
      ? "全部词库"
      : state.filter === "builtin"
        ? "内置词库"
        : state.filter === "trash"
          ? "回收站"
          : "我的词库";
  $("librarySubtitle").textContent = state.user
    ? `${state.user.name} 的私人空间 · ${state.mine.length} 本词库`
    : "访客也能创建词库。登录后，可把它们复制到你的账号。";
  if (state.filter === "all")
    $("librarySubtitle").textContent =
      `${state.catalog.length} 本系统内置 · ${state.mine.length} 本${state.user ? "我的词库" : "访客词库"} · 学习进度${state.user ? "按账号保存" : "保存在此浏览器"}`;
  if (state.filter === "builtin")
    $("librarySubtitle").textContent =
      `${state.catalog.length} 本常用词库 · 按来源考试标签与词频整理，均含中文释义`;
  if (state.view === "library")
    document.title = "KeyWord · " + $("libraryHeading").textContent;
  document
    .querySelectorAll("[data-filter]")
    .forEach((b) =>
      b.classList.toggle("active", b.dataset.filter === state.filter),
    );
  const query = $("deckSearch").value.trim().toLowerCase();
  const decks = (
    state.filter === "all"
      ? [...state.mine, ...state.catalog]
      : state.filter === "builtin"
        ? state.catalog
        : state.filter === "trash"
          ? state.trash
          : state.mine
  ).filter((d) =>
    (d.title + " " + d.description).toLowerCase().includes(query),
  );
  const grid = $("deckGrid");
  grid.replaceChildren();
  if (!decks.length) {
    const empty = node("div", "empty-state");
    empty.append(node("span", "empty-mark", "Aa"));
    empty.append(
      node(
        "h2",
        "",
        query
          ? "没有找到这本词库"
          : state.filter === "trash"
            ? "回收站是空的。"
            : state.filter === "builtin"
              ? "内置词库暂未加载"
              : "从你的第一本词库开始。",
      ),
    );
    empty.append(
      node(
        "p",
        "",
        query
          ? "换一个关键词，或清空搜索。"
          : state.filter === "mine"
            ? "可以新建、导入，也可以先用内置词库找到手感。"
            : "词库读取失败时，点击右上角重试。",
      ),
    );
    if (state.filter === "mine")
      empty.append(
        button(
          "浏览内置词库",
          () => {
            state.filter = "builtin";
            renderLibrary();
          },
          "btn g",
        ),
      );
    grid.append(empty);
    return;
  }
  decks.forEach((d) => {
    const card = node("article", "deck-card"),
      top = node("div", "deck-top"),
      bottom = node("div", "deck-bottom");
    top.append(
      node("span", "deck-marker", "Aa"),
      node(
        "span",
        "muted",
        `${d.builtin ? "系统内置" : state.user ? "我的词库" : "访客词库"} · ${d.wordCount ?? d.words?.length ?? 0} 词`,
      ),
    );
    const title = node("h2", "", d.title);
    card.append(
      top,
      title,
      node(
        "p",
        "",
        d.description ||
          (d.builtin
            ? "内置词库，可复制后按自己的需要编辑。"
            : "每个词组与释义，都由你来定义。"),
      ),
    );
    if (state.filter === "trash") {
      bottom.append(
        node("span", "muted", "可恢复"),
        button("恢复词库", () => restoreDeck(d)),
      );
    } else {
      const activeRound = state.learning.rounds.find((r) => r.scopeId === d.id);
      const plan = state.learning.plans.find((p) => p.id === d.id);
      if (plan) card.append(progressBlock(plan));
      const practice = button(
        activeRound
          ? `继续练习 · ${activeRound.done}/${activeRound.total}`
          : plan && plan.seen === plan.total
            ? "开始下一遍 →"
            : "开始练习 →",
        () => startPractice(d.id),
      );
      practice.disabled = (d.wordCount ?? d.words?.length ?? 0) === 0;
      bottom.append(
        button("查看词条", () => openDeck(d.id)),
        practice,
      );
    }
    card.append(bottom);
    grid.append(card);
  });
}
for (const b of document.querySelectorAll("[data-filter]"))
  b.addEventListener("click", () => {
    state.filter = b.dataset.filter;
    $("deckSearch").value = "";
    renderLibrary();
  });
$("deckSearch").addEventListener("input", renderLibrary);
async function getDeck(id) {
  const stamp = accountStamp(state);
  if (id.startsWith("guest_")) {
    if (state.user) throw new Error("访客词库不属于当前账号，请先复制到账号");
    const d = await local.get("decks", id);
    assertReady(stamp.owner, stamp.epoch);
    if (!d || d.deletedAt) throw new Error("词库不存在");
    return d;
  }
  return (await api("/api/decks/" + encodeURIComponent(id))).deck;
}
async function openDeck(id) {
  assertReady();
  const epoch = state.epoch,
    d = await getDeck(id);
  if (epoch !== state.epoch) return;
  state.selected = d;
  state.wordPage = 0;
  $("wordSearch").value = "";
  renderDetail();
  navigate("detail");
}
function renderDetail() {
  const d = state.selected;
  if (!d) return;
  $("detailTitle").textContent = d.title;
  $("detailDescription").textContent = d.description || "没有额外说明";
  const provenance = $("detailSource");
  provenance.replaceChildren();
  provenance.hidden = !d.source;
  if (d.source) {
    provenance.append(
      node(
        "summary",
        "",
        `${d.builtin ? "数据来源与收录范围" : "原始数据来源"} · ${d.source.name} · ${d.source.license}`,
      ),
    );
    const body = node("div", "source-body"),
      link = node("a", "", "查看来源与固定版本");
    link.href = d.source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (d.builtin && d.source.selection)
      body.append(node("p", "", d.source.selection));
    if (d.source.revision)
      body.append(node("p", "", "数据版本：" + d.source.revision));
    body.append(link);
    const notice = node("details"),
      text = node("pre", "", d.source.notice);
    notice.append(node("summary", "", "授权说明"), text);
    body.append(notice);
    provenance.append(body);
  }
  $("detailScope").textContent =
    `${d.builtin ? "内置词库 · 只读" : state.user ? "私人词库 · 账号同步" : "访客词库 · 本地保存"} · v${d.version}`;
  $("editButton").textContent = d.builtin ? "复制到我的词库" : "编辑词库";
  $("trashButton").hidden = d.builtin;
  $("appendButton").hidden = d.builtin;
  $("practiceButton").disabled = !d.words.length;
  renderDetailProgress();
  const query = $("wordSearch").value.trim().toLowerCase(),
    filtered = d.words.filter((w) =>
      (w.term + " " + w.meaning).toLowerCase().includes(query),
    );
  state.wordPage = Math.min(
    state.wordPage,
    Math.max(0, Math.ceil(filtered.length / 40) - 1),
  );
  $("wordCount").textContent = query
    ? `找到 ${filtered.length} / ${d.words.length} 条`
    : `共 ${d.words.length} 条`;
  const rows = $("wordRows");
  rows.replaceChildren();
  for (const w of filtered.slice(
    state.wordPage * 40,
    (state.wordPage + 1) * 40,
  )) {
    const tr = node("tr");
    tr.append(node("td", "", w.term), node("td", "", w.meaning || "—"));
    rows.append(tr);
  }
  if (!filtered.length) {
    const tr = node("tr"),
      td = node("td", "muted", "没有词条。可以编辑添加，或批量导入。");
    td.colSpan = 2;
    tr.append(td);
    rows.append(tr);
  }
  paginate($("wordPagination"), filtered.length, state.wordPage, (p) => {
    state.wordPage = p;
    renderDetail();
    $("wordRows")
      .closest(".table-container")
      .scrollIntoView({ block: "start" });
  });
}
$("wordSearch").addEventListener("input", () => {
  state.wordPage = 0;
  renderDetail();
});
$("backLibrary").addEventListener("click", () => navigate("library"));
for (const id of ["changeDeckButton", "chooseDeckButton"])
  $(id).addEventListener("click", () => navigate("library"));
function progressBlock(plan) {
  const block = node("div", "deck-progress");
  const meter = node("progress");
  meter.max = plan.total || 1;
  meter.value = plan.seen;
  meter.setAttribute(
    "aria-label",
    `第 ${plan.cycle} 遍已练 ${plan.seen} / ${plan.total} 条`,
  );
  block.append(
    node(
      "span",
      "",
      `第 ${plan.cycle} 遍 · 已练 ${plan.seen} / ${plan.total}${plan.skipped ? " · 跳过 " + plan.skipped : ""}`,
    ),
    meter,
  );
  return block;
}
function renderDetailProgress() {
  const d = state.selected,
    box = $("detailProgress");
  box.replaceChildren();
  if (!d) {
    box.hidden = true;
    return;
  }
  const plan = state.learning.plans.find((p) => p.id === d.id);
  const round = state.learning.rounds.find((r) => r.scopeId === d.id);
  $("practiceButton").textContent = round
    ? `继续练习 · ${round.done}/${round.total}`
    : plan && plan.seen === plan.total
      ? "开始下一遍 →"
      : "开始练习 →";
  box.hidden = !plan;
  if (plan) {
    box.append(progressBlock(plan));
    if (plan.deckVersion !== d.version)
      box.append(
        node(
          "p",
          "muted",
          `当前学习快照 v${plan.deckVersion}；下一组将接入新版词条。`,
        ),
      );
  }
}
function renderResumeList() {
  const box = $("resumeList");
  box.replaceChildren();
  $("resumePanel").hidden =
    !$("practiceBody").hidden || !state.learning.rounds.length;
  for (const r of state.learning.rounds) {
    const card = node("div", "resume-item");
    const label = node("div");
    label.append(
      node("strong", "", r.title),
      node(
        "span",
        "muted",
        `${r.conflict ? "本机进度冲突 · " : r.local ? "本机待同步 · " : ""}已练 ${r.done} / ${r.total} · ${new Date(r.updatedAt).toLocaleString("zh-CN")}`,
      ),
    );
    card.append(
      label,
      button(
        r.conflict ? "处理本机副本 →" : "继续这一轮 →",
        () => startPractice(r.scopeId, { roundId: r.id }),
        "btn g",
      ),
    );
    box.append(card);
  }
}
function mountRound(round) {
  practiceOwner = owner();
  message("");
  trainer.setBlocked(false);
  $("checkpointConflict").hidden = true;
  trainer.restore(
    {
      id: round.scopeId,
      title: round.title,
      version: round.deckVersion,
      words: round.words,
    },
    round.checkpoint,
    round.id,
  );
  $("sessionSaveStatus").textContent =
    round.status === "done" ? "本轮记录已保存。" : "";
  navigate("practice");
}
async function startPractice(id, options = {}) {
  assertReady();
  if (state.starting) return;
  state.starting = true;
  const stamp = accountStamp(state);
  try {
    trainer.pause();
    const round = await learning.start(id, options);
    assertReady(stamp.owner, stamp.epoch);
    mountRound(round);
    await learning.refresh();
  } catch (error) {
    if (learning.frozen && learning.active) {
      const cached = learning.active;
      mountRound({ ...cached.round, checkpoint: cached.checkpoint });
      trainer.setBlocked(true);
      $("checkpointConflict").hidden = false;
      $("checkpointConflictText").textContent =
        cached.error || errorText(error);
    }
    throw error;
  } finally {
    state.starting = false;
  }
}
async function restartPractice() {
  if (!learning.active) return;
  const r = learning.active.round;
  if (
    !trainer.state.done &&
    !confirm("重新开始本轮？整库已练进度与错词会保留，本轮计时和连击重新开始。")
  )
    return;
  if (trainer.state.done && ["retry", "extra"].includes(r.kind)) {
    mountRound(await learning.retry(r.words.map((w) => w.id)));
    return;
  }
  await startPractice(r.scopeId, { restart: !trainer.state.done });
}
async function retryWrong(ids) {
  const stamp = accountStamp(state);
  const round = await learning.retry(ids);
  assertReady(stamp.owner, stamp.epoch);
  mountRound(round);
  await learning.refresh();
}
function saveCheckpoint(checkpoint) {
  if (practiceOwner !== owner() || !state.known || !learning.active) return;
  learning.capture(checkpoint);
}
$("keepLocalRoundButton").addEventListener("click", () =>
  safe(async () => {
    const stamp = accountStamp(state),
      round = await learning.fork();
    assertReady(stamp.owner, stamp.epoch);
    mountRound(round);
    await learning.refresh();
  }),
);
$("loadRemoteRoundButton").addEventListener("click", () =>
  safe(async () => {
    if (
      !learning.active ||
      !confirm(
        "载入最新进度会替换本机这一份。需要保留时，请先另存本机这一轮或导出数据。",
      )
    )
      return;
    const r = learning.active.round;
    await startPractice(r.scopeId, { roundId: r.id, discard: true });
  }),
);
async function loadReviews() {
  assertReady();
  const stamp = accountStamp(state);
  const entries = await learning.reviews();
  if (!accountCurrent(state, stamp)) return;
  state.reviews = entries;
  renderReviews();
}
function renderReviews() {
  const active = state.reviews.filter((e) => e.active),
    query = $("reviewSearch").value.trim().toLowerCase();
  $("reviewActiveCount").textContent = active.length;
  $("reviewMasteredCount").textContent = state.reviews.length - active.length;
  const resume = state.learning.rounds.find((r) => r.scopeId === "review");
  $("reviewPracticeButton").disabled = !active.length && !resume;
  $("reviewPracticeButton").textContent = resume
    ? `继续复习 · ${resume.done}/${resume.total}`
    : "开始复习 →";
  document
    .querySelectorAll("[data-review-filter]")
    .forEach((b) =>
      b.classList.toggle(
        "active",
        b.dataset.reviewFilter === state.reviewFilter,
      ),
    );
  const entries = state.reviews
    .filter((e) => e.active === (state.reviewFilter === "active"))
    .filter((e) =>
      [e.term, e.meaning, ...e.sources.map((s) => s.title)]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  state.reviewPage = Math.min(
    state.reviewPage,
    Math.max(0, Math.ceil(entries.length / 30) - 1),
  );
  const list = $("reviewList");
  list.replaceChildren();
  if (!entries.length) {
    const empty = node("div", "empty-state");
    empty.append(
      node("span", "empty-mark", "Aa"),
      node(
        "h2",
        "",
        query
          ? "没有匹配的错词"
          : state.reviewFilter === "active"
            ? "暂时没有待复习的词。"
            : "已掌握的词会留在这里。",
      ),
      node(
        "p",
        "",
        state.reviewFilter === "active"
          ? "其他词库里输入出错或跳过的词会自动加入。"
          : "归档不删除历史；以后再错会重新进入待复习。",
      ),
    );
    list.append(empty);
  }
  for (const entry of entries.slice(
    state.reviewPage * 30,
    (state.reviewPage + 1) * 30,
  )) {
    const row = node("article", "review-row"),
      body = node("div", "review-word"),
      meta = node("div", "review-meta");
    body.append(
      node("h2", "", entry.term),
      node("p", "", entry.meaning || "无释义"),
    );
    const sourceTitles = [...new Set(entry.sources.map((s) => s.title))];
    meta.append(
      node(
        "span",
        "",
        `${entry.wrongRounds >= 2 ? "常错 · " : ""}出错 ${entry.wrongRounds} 轮 · ${entry.active ? "连续无错 " + entry.cleanStreak + "/2" : entry.reason === "manual" ? "手动移出" : "已通过两次无错练习"}`,
      ),
      node("span", "muted", "来源：" + sourceTitles.join("、")),
    );
    row.append(
      body,
      meta,
      button(
        entry.active ? "已掌握 · 移出" : "恢复复习",
        async () => {
          await learning.setReview(entry, !entry.active);
          await loadReviews();
          $("reviewFeedback").textContent = state.learningPending
            ? "操作已保存在本机，等待同步。"
            : entry.active
              ? "已移到已掌握，历史记录仍保留。"
              : "已恢复到待复习。";
        },
        "text-button",
      ),
    );
    list.append(row);
  }
  paginate(
    $("reviewPagination"),
    entries.length,
    state.reviewPage,
    (p) => {
      state.reviewPage = p;
      renderReviews();
    },
    30,
  );
}
$("reviewPracticeButton").addEventListener("click", () =>
  safe(() => startPractice("review")),
);
$("discardReviewActions").addEventListener("click", () =>
  safe(async () => {
    await learning.clearReviewConflicts();
    await loadReviews();
  }),
);
$("reviewSearch").addEventListener("input", () => {
  state.reviewPage = 0;
  renderReviews();
});
for (const b of document.querySelectorAll("[data-review-filter]"))
  b.addEventListener("click", () => {
    state.reviewFilter = b.dataset.reviewFilter;
    state.reviewPage = 0;
    renderReviews();
  });
$("practiceButton").addEventListener("click", () =>
  safe(() => startPractice(state.selected.id)),
);
function editorPayload() {
  return {
    title: $("editTitle").value,
    description: $("editDescription").value,
    words: state.editor?.words || [],
    ...(state.editor?.source ? { source: state.editor.source } : {}),
  };
}
function editorDirty() {
  return (
    state.editor && JSON.stringify(editorPayload()) !== state.editor.initial
  );
}
function openEditor(deck) {
  assertReady();
  const copy = deck
    ? structuredClone(deck)
    : {
        title: "",
        description: "",
        words: [{ id: newId(), term: "", meaning: "" }],
      };
  state.editor = { ...copy, owner: owner(), epoch: state.epoch, initial: "" };
  state.editorPage = 0;
  $("editTitle").value = copy.title;
  $("editDescription").value = copy.description;
  state.editor.initial = JSON.stringify(editorPayload());
  $("editorHeading").textContent = deck ? "编辑词库" : "新建词库";
  $("editorError").textContent = "";
  $("conflictActions").hidden = true;
  $("editorStorageHint").textContent = state.user
    ? "保存到当前账号 · 仅自己可见"
    : "保存在此浏览器 · 登录后可复制到账号";
  renderEditorRows();
  showDialog("editorDialog");
}
function renderEditorRows() {
  const d = state.editor;
  if (!d) return;
  $("editorCount").textContent = d.words.length;
  const rows = $("editorRows");
  rows.replaceChildren();
  state.editorPage = Math.min(
    state.editorPage,
    Math.max(0, Math.ceil(d.words.length / 40) - 1),
  );
  d.words
    .slice(state.editorPage * 40, (state.editorPage + 1) * 40)
    .forEach((w, offset) => {
      const index = state.editorPage * 40 + offset,
        tr = node("tr");
      for (const field of ["term", "meaning"]) {
        const td = node("td"),
          input = node("input");
        input.value = w[field];
        input.maxLength = field === "term" ? 160 : 1000;
        input.setAttribute(
          "aria-label",
          `第 ${index + 1} 条${field === "term" ? "英文" : "释义"}`,
        );
        input.addEventListener("input", () => {
          w[field] = input.value;
        });
        td.append(input);
        tr.append(td);
      }
      const td = node("td"),
        remove = button(
          "×",
          () => {
            d.words.splice(index, 1);
            renderEditorRows();
          },
          "",
        );
      remove.setAttribute("aria-label", `移除第 ${index + 1} 条词`);
      td.append(remove);
      tr.append(td);
      rows.append(tr);
    });
  paginate($("editorPagination"), d.words.length, state.editorPage, (p) => {
    state.editorPage = p;
    renderEditorRows();
  });
}
$("createButton").addEventListener("click", () => safe(() => openEditor()));
$("addWordButton").addEventListener("click", () => {
  if (state.editor.words.length >= MAX_WORDS) {
    $("editorError").textContent = `每个词库最多 ${MAX_WORDS} 条`;
    return;
  }
  state.editor.words.push({ id: newId(), term: "", meaning: "" });
  state.editorPage = Math.floor((state.editor.words.length - 1) / 40);
  renderEditorRows();
  $("editorRows").lastElementChild?.querySelector("input").focus();
});
$("editButton").addEventListener("click", () =>
  safe(async () => {
    if (!state.selected.builtin) {
      openEditor(state.selected);
      return;
    }
    await busy($("editButton"), "复制中…", async () => {
      const raw = {
          ...state.selected,
          title: state.selected.title + " · 我的副本",
        },
        stamp = accountStamp(state);
      const d = state.user
        ? (await api("/api/decks", { method: "POST", body: raw })).deck
        : await local.create(raw);
      assertReady(stamp.owner, stamp.epoch);
      await refresh({ identity: false });
      assertReady(stamp.owner, stamp.epoch);
      state.selected = d;
      renderDetail();
      openEditor(d);
      message("已复制为私人词库，内置原件保持不变。");
    });
  }),
);
$("editorForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!state.editor) return;
  busy(
    $("saveDeckButton"),
    "保存中…",
    async () => {
      const draft = state.editor;
      assertReady(draft.owner, draft.epoch);
      const raw = editorPayload();
      raw.words = raw.words.filter((w) => w.term.trim() || w.meaning.trim());
      const payload = validateDeck(raw);
      let d;
      try {
        if (draft.id)
          d = state.user
            ? (
                await api("/api/decks/" + draft.id, {
                  method: "PUT",
                  body: { ...payload, version: draft.version },
                  expectedOwner: draft.owner,
                })
              ).deck
            : await local.update(draft.id, {
                ...payload,
                version: draft.version,
              });
        else
          d = state.user
            ? (
                await api("/api/decks", {
                  method: "POST",
                  body: payload,
                  expectedOwner: draft.owner,
                })
              ).deck
            : await local.create(payload);
      } catch (error) {
        if (error.status === 409) $("conflictActions").hidden = false;
        throw error;
      }
      assertReady(draft.owner, draft.epoch);
      closeDialog("editorDialog");
      await refresh({ identity: false });
      assertReady(draft.owner, draft.epoch);
      state.selected = d;
      state.wordPage = 0;
      $("wordSearch").value = "";
      renderDetail();
      navigate("detail");
      message("词库已保存。");
    },
    $("editorError"),
  );
});
$("draftExportButton").addEventListener("click", () =>
  download(
    "词库草稿.json",
    JSON.stringify(makeBackup([editorPayload()]), null, 2),
    "application/json",
  ),
);
$("reloadEditorButton").addEventListener("click", () =>
  safe(async () => {
    if (!confirm("载入最新版本会替换当前草稿，已先导出需要保留的内容吗？"))
      return;
    const d = await getDeck(state.editor.id);
    openEditor(d);
  }),
);
$("trashButton").addEventListener("click", () =>
  safe(async () => {
    const d = state.selected,
      stamp = accountStamp(state);
    if (!confirm(`将“${d.title}”移入回收站？之后可以恢复，练习记录会保留。`))
      return;
    await busy($("trashButton"), "处理中…", async () => {
      if (state.user)
        await api("/api/decks/" + d.id, {
          method: "DELETE",
          body: { version: d.version },
        });
      else await local.trash(d.id, d.version);
      assertReady(stamp.owner, stamp.epoch);
      state.selected = null;
      await refresh({ identity: false });
      assertReady(stamp.owner, stamp.epoch);
      navigate("library");
      message("已移入回收站。");
    });
  }),
);
async function restoreDeck(d) {
  const stamp = accountStamp(state);
  if (state.user)
    await api("/api/decks/" + d.id + "/restore", {
      method: "POST",
      body: { version: d.version },
    });
  else await local.trash(d.id, d.version, true);
  assertReady(stamp.owner, stamp.epoch);
  await refresh({ identity: false });
  assertReady(stamp.owner, stamp.epoch);
  message("词库已恢复。");
}
function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type })),
    a = node("a");
  a.href = url;
  a.download = filename.replace(/[\\/:*?"<>|]/g, "_");
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportDecks(decks, format) {
  if (format === "csv")
    download("词库.csv", exportCSV(decks), "text/csv;charset=utf-8");
  else if (format === "txt")
    download("词库.txt", exportTXT(decks), "text/plain;charset=utf-8");
  else
    download(
      "词库备份.json",
      JSON.stringify(makeBackup(decks), null, 2),
      "application/json",
    );
}
$("exportButton").addEventListener("click", () =>
  exportDecks([state.selected], $("exportFormat").value),
);
async function backup() {
  assertReady();
  const stamp = accountStamp(state),
    who = stamp.owner;
  const data = state.user
    ? await api("/api/export")
    : makeBackup(await local.all("decks"), await local.all("sessions"));
  assertReady(who, stamp.epoch);
  data.pendingSessions = (await local.all("outbox"))
    .filter((x) => x.ownerId === who)
    .map((x) => x.result);
  data.pendingSessions.push(
    ...[...unpersistedResults.values()]
      .filter((x) => x.ownerId === who)
      .map((x) => x.result),
  );
  data.localLearning = await learning.export();
  if (!state.user) data.sessions.push(...(await learning.guest("sessions")));
  assertReady(who, stamp.epoch);
  download(
    "KeyWord-数据备份.json",
    JSON.stringify(data, null, 2),
    "application/json",
  );
  message("已导出词库、练习记录和待同步记录。账号密码不包含在此文件中。");
}
$("backupButton").addEventListener("click", () => safe(backup));
$("accountBackupButton").addEventListener("click", () => safe(backup));
function invalidatePreview() {
  state.importPreview = null;
  state.importOperation = null;
  $("applyImportButton").disabled = true;
  $("importPreview").replaceChildren();
  $("importSummary").textContent = "内容已变更，请重新预览";
  $("importError").textContent = "";
}
function importMode() {
  $("importTargetField").hidden = $("importMode").value === "new";
  $("replaceConfirmField").hidden = $("importMode").value !== "replace";
  $("applyImportButton").disabled =
    !state.importPreview ||
    state.importPreview.issues.some((x) => x.level === "error") ||
    !state.importPreview.decks.length ||
    ($("importMode").value === "replace" && !$("replaceConfirm").checked);
}
function openImport({ content = "", name = "新词库", target } = {}) {
  assertReady();
  state.importOwner = owner();
  state.importEpoch = state.epoch;
  $("importName").value = name;
  $("importText").value = content;
  $("importFile").value = "";
  $("importFormat").value = "auto";
  $("replaceConfirm").checked = false;
  $("importMode").value = target ? "append" : "new";
  $("importTarget").replaceChildren();
  for (const d of state.mine) {
    const option = node("option", "", d.title);
    option.value = d.id;
    $("importTarget").append(option);
  }
  if (target) $("importTarget").value = target;
  invalidatePreview();
  $("importSummary").textContent = "先预览，确认后再写入";
  importMode();
  showDialog("importDialog");
}
$("importButton").addEventListener("click", () => safe(() => openImport()));
$("appendButton").addEventListener("click", () =>
  safe(() =>
    openImport({ target: state.selected.id, name: state.selected.title }),
  ),
);
for (const id of ["importText", "importName"])
  $(id).addEventListener("input", invalidatePreview);
$("importFormat").addEventListener("change", invalidatePreview);
$("importMode").addEventListener("change", importMode);
$("replaceConfirm").addEventListener("change", importMode);
$("importFile").addEventListener("change", () =>
  safe(async () => {
    const stamp = accountStamp(state);
    const file = $("importFile").files[0];
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) {
      $("importError").textContent = "文件超过 3 MB，请分批导入";
      return;
    }
    const text = await file.text();
    assertReady(stamp.owner, stamp.epoch);
    $("importText").value = text;
    $("importName").value = file.name;
    invalidatePreview();
  }),
);
$("previewButton").addEventListener("click", () => {
  const parsed = parseImport($("importText").value, {
    format: $("importFormat").value,
    filename: $("importName").value,
  });
  state.importPreview = parsed;
  const view = $("importPreview");
  view.replaceChildren();
  const count = parsed.decks.reduce((n, d) => n + d.words.length, 0),
    errors = parsed.issues.filter((x) => x.level === "error").length;
  view.append(
    node(
      "p",
      "preview-summary",
      `${parsed.decks.length} 本词库 · ${count} 条有效词 · ${errors} 个错误${parsed.duplicateCount ? " · " + parsed.duplicateCount + " 条完全重复" : ""}`,
    ),
  );
  for (const issue of parsed.issues.slice(0, 50))
    view.append(
      node(
        "p",
        "import-issue " + issue.level,
        `${issue.line ? "第 " + issue.line + " 行：" : ""}${issue.message}`,
      ),
    );
  if (parsed.issues.length > 50)
    view.append(node("p", "muted", "仅显示前 50 条问题，请修正后重新预览。"));
  for (const d of parsed.decks.slice(0, 30)) {
    const block = node("div", "preview-deck");
    block.append(node("strong", "", `${d.title} · ${d.words.length} 词`));
    d.words
      .slice(0, 5)
      .forEach((w) =>
        block.append(
          node("p", "preview-word", w.term + " — " + (w.meaning || "无释义")),
        ),
      );
    if (d.words.length > 5)
      block.append(node("p", "muted", `另有 ${d.words.length - 5} 条`));
    view.append(block);
  }
  $("importSummary").textContent = errors
    ? "请修正错误后再导入；尚未写入任何词库"
    : count
      ? `${count} 条词等待确认`
      : "没有解析到有效词条";
  importMode();
});
$("applyImportButton").addEventListener("click", () => {
  busy(
    $("applyImportButton"),
    "正在写入…",
    async () => {
      const who = state.importOwner,
        epoch = state.importEpoch;
      assertReady(who, epoch);
      const parsed = state.importPreview;
      if (
        !parsed?.decks.length ||
        parsed.issues.some((x) => x.level === "error")
      )
        throw new Error("请先修正导入错误");
      let decks;
      if ($("importMode").value === "new") {
        decks = state.user
          ? (
              await api("/api/decks/import", {
                method: "POST",
                body: {
                  decks: parsed.decks,
                  operationId: (state.importOperation ||= newId()),
                },
                expectedOwner: who,
              })
            ).decks
          : await local.import(parsed.decks);
      } else {
        const id = $("importTarget").value;
        if (!id) throw new Error("请先选择目标词库，或切换到新建词库");
        if ($("importMode").value === "replace" && !$("replaceConfirm").checked)
          throw new Error("请确认替换词条");
        const current = await getDeck(id),
          incoming = parsed.decks.flatMap((d) => d.words);
        const words =
          $("importMode").value === "append"
            ? mergeWords(current.words, incoming)
            : incoming.map((w) => ({ ...w, id: newId() }));
        const payload = { ...current, words };
        validateDeck(payload);
        const d = state.user
          ? (
              await api("/api/decks/" + id, {
                method: "PUT",
                body: payload,
                expectedOwner: who,
              })
            ).deck
          : await local.update(id, payload);
        decks = [d];
      }
      assertReady(who, epoch);
      if ($("importName").value === "旧版我的词库")
        await local.put("meta", {
          id: "legacy-imported",
          at: new Date().toISOString(),
        });
      state.importOperation = null;
      closeDialog("importDialog");
      await refresh({ identity: false });
      assertReady(who, epoch);
      state.filter = "all";
      navigate("library");
      message(`已保存 ${decks.length} 本词库。`);
    },
    $("importError"),
  ).then(importMode);
});
async function checkMigration(stamp = accountStamp(state)) {
  const guests = (await local.all("decks")).filter((d) => !d.deletedAt);
  const completed = state.user
    ? (await local.get("meta", "migrated:" + state.user.id))?.ids || []
    : [];
  if (!accountCurrent(state, stamp)) return;
  state.migration = guests.filter((d) => !completed.includes(d.id));
  $("guestMigration").hidden = !state.user || !state.migration.length;
  $("migrationText").textContent =
    `${state.migration.length} 本词库可复制到当前账号，访客原件和记录会保留。`;
  let raw = "";
  try {
    raw = localStorage.getItem("keystroke.mine.v1") || "";
  } catch {}
  const legacyImported = await local.get("meta", "legacy-imported");
  if (accountCurrent(state, stamp))
    $("legacyNotice").hidden = !raw || !!legacyImported;
}
$("legacyImportButton").addEventListener("click", () =>
  safe(() => {
    openImport({
      content: localStorage.getItem("keystroke.mine.v1") || "",
      name: "旧版我的词库",
    });
  }),
);
$("migrateButton").addEventListener("click", () =>
  busy($("migrateButton"), "复制中…", async () => {
    assertReady();
    if (!state.user) return;
    const stamp = accountStamp(state),
      who = stamp.owner,
      key = "migration-pending:" + who;
    let pending = await local.get("meta", key);
    assertReady(who, stamp.epoch);
    if (!pending) {
      pending = {
        id: key,
        operationId: newId(),
        decks: state.migration.slice(0, 30),
      };
      await local.put("meta", pending);
    }
    await api("/api/decks/import", {
      method: "POST",
      body: { decks: pending.decks, operationId: pending.operationId },
      expectedOwner: who,
    });
    assertReady(who, stamp.epoch);
    const done = (await local.get("meta", "migrated:" + who))?.ids || [];
    await local.put("meta", {
      id: "migrated:" + who,
      ids: [...new Set([...done, ...pending.decks.map((d) => d.id)])],
    });
    await local.remove("meta", key);
    await refresh({ identity: false });
    assertReady(who, stamp.epoch);
    message("访客词库已复制到当前账号，原件仍在访客空间。");
  }),
);
function clearAdminView() {
  state.revokeInvite = null;
  state.invitations = [];
  state.invitePage = 0;
  $("inviteList").replaceChildren();
  $("invitePagination").replaceChildren();
  $("newInviteCode").value = "";
  $("newInvitePanel").hidden = true;
  $("inviteCreateError").textContent = "";
  $("adminFeedback").textContent = "";
  $("inviteLabel").value = "";
  $("inviteDays").value = "7";
  $("inviteSearch").value = "";
  $("inviteStatus").value = "all";
}
function assertAdmin() {
  assertReady();
  if (state.user.role !== "admin") throw new Error("仅管理员可访问");
}
const inviteStatuses = {
  available: "可使用",
  used: "已使用",
  expired: "已过期",
  revoked: "已撤销",
};
const inviteDate = (time) =>
  new Date(time).toLocaleString("zh-CN", { hour12: false });
async function loadInvitations() {
  assertAdmin();
  const stamp = accountStamp(state);
  try {
    const data = await api("/api/admin/invitations");
    if (!accountCurrent(state, stamp)) return;
    const changed =
      JSON.stringify(state.invitations) !== JSON.stringify(data.invitations);
    state.invitations = data.invitations;
    $("adminFeedback").textContent = "";
    if (changed || !$("inviteList").children.length) renderInvitations();
  } catch (error) {
    if (!accountCurrent(state, stamp)) return;
    if (error.status === 403) {
      state.user.role = "user";
      clearAdminView();
      navigate("library");
      syncLabel();
      message("管理员权限已失效。", true);
      return;
    }
    $("adminFeedback").textContent = errorText(error);
  }
}
async function copyInvite(code) {
  assertAdmin();
  if (!navigator.clipboard?.writeText)
    throw new Error("浏览器不支持自动复制，请选中邀请码手动复制。");
  await navigator.clipboard.writeText(code);
  message("邀请码已复制，请通过私密渠道发送。");
}
function renderInvitations() {
  const list = $("inviteList"),
    query = $("inviteSearch").value.trim().toLowerCase(),
    status = $("inviteStatus").value;
  list.replaceChildren();
  const all = state.invitations,
    available = all.filter((i) => i.status === "available").length;
  $("adminSubtitle").textContent =
    `${available} 个可使用 · 共 ${all.length} 个邀请码 · 每码限注册一个账号`;
  const filtered = all.filter(
    (i) =>
      (status === "all" || status === i.status) &&
      [i.label, i.hint, i.usedEmail, i.code].some((value) =>
        value?.toLowerCase().includes(query),
      ),
  );
  state.invitePage = Math.max(
    0,
    Math.min(state.invitePage, Math.ceil(filtered.length / 20) - 1),
  );
  if (!filtered.length)
    list.append(
      node(
        "p",
        "empty",
        all.length
          ? "没有符合条件的邀请码。"
          : "还没有邀请码，生成一个邀请朋友加入。",
      ),
    );
  for (const invite of filtered.slice(
    state.invitePage * 20,
    (state.invitePage + 1) * 20,
  )) {
    const row = node("article", "invite-row"),
      identity = node("div", "invite-identity"),
      meta = node("div", "invite-meta"),
      actions = node("div", "invite-actions");
    identity.append(node("strong", "", invite.label || "未备注"));
    if (invite.code) {
      const label = node("label", "invite-code-field"),
        input = node("input");
      label.append(
        node("span", "sr-only", `${invite.label || "未备注"}的邀请码`),
      );
      input.value = invite.code;
      input.readOnly = true;
      input.spellcheck = false;
      label.append(input);
      identity.append(label);
      actions.append(
        button("复制", () => copyInvite(invite.code), "text-button"),
      );
    } else {
      identity.append(
        node("p", "muted", invite.hint ? "尾号 " + invite.hint : "旧版邀请码"),
      );
      if (invite.status === "available")
        identity.append(
          node(
            "p",
            "muted",
            invite.displayError ||
              "此码仅保存了散列，无法回显；可撤销后重新生成。",
          ),
        );
    }
    meta.append(
      node(
        "span",
        "invite-status " + invite.status,
        inviteStatuses[invite.status],
      ),
    );
    meta.append(
      node("span", "muted", "有效至 " + inviteDate(invite.expiresAt)),
    );
    if (invite.usedEmail)
      meta.append(node("span", "muted", "使用者 " + invite.usedEmail));
    if (invite.role === "admin")
      meta.append(node("span", "muted", "管理员初始化码"));
    if (invite.status === "available")
      actions.append(
        button(
          "撤销",
          () => {
            assertAdmin();
            state.revokeInvite = invite;
            $("revokeInviteText").textContent =
              invite.label || "尾号 " + (invite.hint || invite.id);
            $("revokeInviteError").textContent = "";
            showDialog("revokeInviteDialog");
          },
          "text-button danger",
        ),
      );
    row.append(identity, meta, actions);
    list.append(row);
  }
  paginate(
    $("invitePagination"),
    filtered.length,
    state.invitePage,
    (page) => {
      state.invitePage = page;
      renderInvitations();
    },
    20,
  );
}
$("inviteCreateForm").addEventListener("submit", (event) => {
  event.preventDefault();
  busy(
    $("inviteCreateButton"),
    "生成中…",
    async () => {
      assertAdmin();
      const { invitation } = await api("/api/admin/invitations", {
        method: "POST",
        body: {
          days: Number($("inviteDays").value),
          label: $("inviteLabel").value.trim(),
        },
      });
      $("newInviteCode").value = invitation.code;
      $("newInviteExpiry").textContent =
        "一次性使用 · 有效至 " + inviteDate(invitation.expiresAt);
      $("newInvitePanel").hidden = false;
      $("inviteLabel").value = "";
      await loadInvitations();
    },
    $("inviteCreateError"),
  );
});
$("copyNewInvite").addEventListener("click", () =>
  safe(() => copyInvite($("newInviteCode").value)),
);
$("confirmRevokeInvite").addEventListener("click", () =>
  busy(
    $("confirmRevokeInvite"),
    "撤销中…",
    async () => {
      assertAdmin();
      const invite = state.revokeInvite,
        stamp = accountStamp(state);
      if (!invite) return;
      await api(`/api/admin/invitations/${invite.id}/revoke`, {
        method: "POST",
        body: {},
      });
      if ($("newInviteCode").value === invite.code) {
        $("newInviteCode").value = "";
        $("newInvitePanel").hidden = true;
      }
      closeDialog("revokeInviteDialog");
      await loadInvitations();
      assertReady(stamp.owner, stamp.epoch);
      message("邀请码已撤销。");
    },
    $("revokeInviteError"),
  ),
);
$("adminRefreshButton").addEventListener("click", () =>
  busy($("adminRefreshButton"), "刷新中…", loadInvitations, $("adminFeedback")),
);
for (const [id, event] of [
  ["inviteStatus", "change"],
  ["inviteSearch", "input"],
])
  $(id).addEventListener(event, () => {
    state.invitePage = 0;
    renderInvitations();
  });

function authMode(mode) {
  state.authMode = mode;
  const signup = mode === "signup";
  $("signupNameField").hidden = !signup;
  $("authName").required = signup;
  $("inviteCodeField").hidden = !signup;
  $("inviteCode").required = signup;
  $("inviteHint").hidden = !signup;
  if (!signup) $("inviteCode").value = "";
  $("authHeading").textContent = signup ? "邀请码注册" : "登录账号";
  $("authSubmit").textContent = signup ? "创建账号" : "登录";
  $("authToggle").textContent = signup ? "已有账号？去登录" : "使用邀请码注册";
  $("authPassword").autocomplete = signup ? "new-password" : "current-password";
  $("authError").textContent = "";
}
$("accountButton").addEventListener("click", () => {
  if (state.user) {
    $("profileName").textContent = state.user.name;
    $("profileEmail").textContent = state.user.email;
    $("profileError").textContent = "";
    showDialog("profileDialog");
  } else {
    authMode("login");
    showDialog("authDialog");
  }
});
$("authToggle").addEventListener("click", () =>
  authMode(state.authMode === "login" ? "signup" : "login"),
);

$("authForm").addEventListener("submit", (e) => {
  e.preventDefault();
  busy(
    $("authSubmit"),
    state.authMode === "login" ? "登录中…" : "创建中…",
    async () => {
      const signup = state.authMode === "signup";
      try {
        await api("/api/auth/" + (signup ? "sign-up" : "sign-in") + "/email", {
          method: "POST",
          body: {
            email: $("authEmail").value.trim(),
            password: $("authPassword").value,
            ...(signup
              ? {
                  name: $("authName").value.trim(),
                  inviteCode: $("inviteCode").value.trim(),
                }
              : {}),
          },
        });
      } catch (error) {
        if (error.status === 429) throw new Error("尝试过于频繁，请稍后再试");
        throw error;
      }
      $("authPassword").value = "";
      const signedIn = (await api("/api/me")).user;
      if (!signedIn)
        throw new Error("登录未建立，请检查浏览器是否允许保存 Cookie 后重试");
      adoptUser(signedIn);
      announceIdentity();
      closeDialog("authDialog");
      await synchronize({ identity: false });
      navigate("library");
      message("已登录，个人词库和学习进度已切换到当前账号。");
    },
    $("authError"),
  );
});
$("logoutButton").addEventListener("click", () =>
  busy(
    $("logoutButton"),
    "退出中…",
    async () => {
      if (
        [...unpersistedResults.values(), ...learning.memory.values()].some(
          (x) => x.ownerId === owner(),
        )
      )
        throw new Error(
          "这轮练习还未保存在本机，请先重试同步或导出数据，再退出登录",
        );
      await api("/api/auth/sign-out", { method: "POST", body: {} });
      adoptUser(null);
      announceIdentity();
      closeDialog("profileDialog");
      await synchronize({ identity: false });
      navigate("library");
      authMode("login");
      $("authEmail").focus();
    },
    $("profileError"),
  ),
);
$("passwordForm").addEventListener("submit", (e) => {
  e.preventDefault();
  busy(
    $("changePasswordButton"),
    "更新中…",
    async () => {
      await api("/api/auth/change-password", {
        method: "POST",
        body: {
          currentPassword: $("currentPassword").value,
          newPassword: $("newPassword").value,
          revokeOtherSessions: true,
        },
      });
      $("currentPassword").value = "";
      $("newPassword").value = "";
      announceIdentity();
      $("profileError").textContent = "密码已更新，其他设备需要重新登录。";
    },
    $("profileError"),
  );
});
async function persistResults(who) {
  for (const [id, item] of unpersistedResults) {
    if (item.ownerId !== who) continue;
    await local.put(
      who === "guest" ? "sessions" : "outbox",
      who === "guest" ? { ...item.result, ownerId: "guest" } : item,
    );
    unpersistedResults.delete(id);
  }
}
async function savePractice(result) {
  if (learning.active?.round.id === result.id) {
    await learning.flush();
    if (state.view === "history") await loadHistory();
    return;
  }
  const status = $("sessionSaveStatus"),
    stamp = accountStamp(state),
    who = practiceOwner;
  const pending = {
    id: who + ":" + result.id,
    ownerId: who,
    result,
    state: "pending",
  };
  unpersistedResults.set(pending.id, pending);
  status.classList.remove("error");
  status.textContent = "正在保存本轮记录…";
  try {
    // The round's owner is fixed when it starts; a late save never adopts a new login.
    await persistResults(who);
    if (!accountCurrent(state, stamp) || owner() !== who) return;
    if (who === "guest") {
      status.textContent = "本轮记录已保存在此浏览器。";
      return;
    }
    await flushOutbox();
    const remaining = await local.get("outbox", pending.id);
    if (!accountCurrent(state, stamp)) return;
    status.textContent = remaining
      ? "本轮已保存在本机，等待同步。"
      : "本轮已同步到账号。";
    status.classList.toggle("error", !!remaining?.error);
  } catch (error) {
    if (!accountCurrent(state, stamp)) return;
    status.classList.add("error");
    status.textContent = errorText(error);
    state.outboxError = errorText(error);
  } finally {
    syncLabel();
  }
}
const flushOutbox = coalesceSync(async ({ retryBlocked }) => {
  if (!state.known) return;
  const stamp = accountStamp(state),
    who = stamp.owner;
  try {
    await persistResults(who);
    if (!accountCurrent(state, stamp)) return;
    if (!state.user) {
      state.outboxError = "";
      return;
    }
    const result = await flushAccountOutbox({
      local,
      ownerId: who,
      retryBlocked,
      isCurrent: () => accountCurrent(state, stamp) && state.known,
      send: (body) =>
        api("/api/sessions", { method: "POST", body, expectedOwner: who }),
    });
    if (!accountCurrent(state, stamp)) return;
    state.pending = result.pending;
    state.outboxError = result.error;
    if (
      state.view === "practice" &&
      practiceOwner === who &&
      $("sessionSaveStatus").textContent &&
      !state.pending.length
    ) {
      $("sessionSaveStatus").textContent = "本轮已同步到账号。";
      $("sessionSaveStatus").classList.remove("error");
    }
  } catch (error) {
    if (accountCurrent(state, stamp)) state.outboxError = errorText(error);
  } finally {
    syncLabel();
  }
});
async function loadHistory() {
  assertReady();
  const who = owner(),
    epoch = state.epoch;
  try {
    const saved = state.user
      ? (await api("/api/sessions")).sessions
      : [
          ...(await local.all("sessions")),
          ...(await learning.guest("sessions")),
        ];
    const queued = state.user
      ? (await local.all("outbox")).filter((x) => x.ownerId === who)
      : [];
    if (epoch !== state.epoch) return;
    const ids = new Set(saved.map((x) => x.id));
    const sessions = [
      ...queued
        .filter((x) => !ids.has(x.result.id))
        .map((x) => ({ ...x.result, pending: true, syncError: x.error })),
      ...saved,
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const changed = JSON.stringify(state.sessions) !== JSON.stringify(sessions);
    state.sessions = sessions;
    $("historySubtitle").textContent = state.user
      ? "每轮独立记录，保留当时的单词与释义；这里显示最近 100 轮，导出包含全部记录。"
      : "访客练习记录只在此浏览器保存。登录后新练习会归入账号。";
    if (changed || state.historyError || !$("historyList").children.length)
      renderHistory();
    state.historyError = false;
  } catch (error) {
    if (
      epoch === state.epoch &&
      who === owner() &&
      error.code !== "STALE_ACCOUNT"
    ) {
      state.historyError = true;
      if (!state.sessions.length)
        $("historyList").replaceChildren(
          node("p", "form-error", errorText(error)),
        );
    }
  }
}
function renderHistory() {
  const list = $("historyList");
  list.replaceChildren();
  if (!state.sessions.length) {
    const empty = node("div", "empty-state");
    empty.append(
      node("span", "empty-mark", "01"),
      node("h2", "", "完成第一轮，就从这里积累。"),
      node("p", "", "用内置词库试试手感，或带上自己的单词。"),
    );
    empty.append(button("去词库", () => navigate("library"), "btn g"));
    list.append(empty);
    return;
  }
  for (const s of state.sessions) {
    const card = node("article", "history-card"),
      top = node("div", "history-top"),
      stats = node("div", "history-stats");
    top.append(
      node("h2", "", s.title),
      node(
        "span",
        "muted",
        `${new Date(s.createdAt).toLocaleString("zh-CN")} · v${s.deckVersion}${s.pending ? " · 待同步" : ""}`,
      ),
    );
    const accuracy = s.keystrokes
        ? Math.round((s.correct / s.keystrokes) * 100)
        : 100,
      wpm =
        s.durationMs < 500
          ? 0
          : Math.round(s.correct / 5 / (s.durationMs / 60000));
    for (const text of [
      `${s.wordsDone} 词完成`,
      `${accuracy}% 准确`,
      `${wpm} WPM`,
      `${Math.round(s.durationMs / 100) / 10} 秒`,
      `${s.skipped} 词跳过`,
    ])
      stats.append(node("span", "", text));
    card.append(top, stats);
    if (s.syncError)
      card.append(node("p", "form-error", s.syncError + "（本机副本已保留）"));
    const details = node("details"),
      summary = node("summary", "", "本轮词条与错词"),
      words = node("div", "history-words");
    details.append(summary, words);
    for (const w of s.words)
      words.append(
        node(
          "span",
          "witem",
          `${w.term} · ${w.meaning || "无释义"}${w.status === "skipped" ? " · 已跳过" : w.mistakes ? " · 错 " + w.mistakes + " 次" : ""}`,
        ),
      );
    card.append(details);
    list.append(card);
  }
}
$("legacyBoardButton").addEventListener("click", () =>
  safe(async () => {
    const data = await api(
        "/api/board?bank=" + encodeURIComponent($("legacyBank").value),
      ),
      list = $("legacyBoardList");
    list.replaceChildren();
    if (!data.board.length) {
      list.append(node("p", "muted", "这张历史榜单没有记录。"));
      return;
    }
    data.board.forEach((r, i) =>
      list.append(
        node(
          "p",
          "muted",
          `${i + 1}. ${r.name} · ${r.time} 秒 · ${r.acc ?? "—"}%`,
        ),
      ),
    );
  }),
);
function savePreferences() {
  try {
    localStorage.setItem(
      "keyword.preferences",
      JSON.stringify({
        ...Object.fromEntries(
          ["cbSound", "cbShow", "cbTTS", "cbCn", "cbOnline"].map((id) => [
            id,
            $(id).checked,
          ]),
        ),
        speech: trainer.speechPreferences(),
      }),
    );
  } catch {
    message("浏览器未允许保存偏好，本次练习仍可继续。", true);
  }
}
function applyTheme(theme) {
  if (!["white", "green", "dark"].includes(theme)) theme = "white";
  document.documentElement.dataset.theme = theme;
  $("themeSelect").value = theme;
  document.querySelector('meta[name="theme-color"]').content = {
    white: "#f2f3f6",
    green: "#edf6ef",
    dark: "#0a0b10",
  }[theme];
  try {
    localStorage.setItem("keystroke.theme", theme);
  } catch {}
}
$("themeSelect").addEventListener("change", () =>
  applyTheme($("themeSelect").value),
);
try {
  applyTheme(localStorage.getItem("keystroke.theme") || "white");
  const prefs = JSON.parse(localStorage.getItem("keyword.preferences") || "{}");
  for (const key of ["cbSound", "cbShow", "cbTTS", "cbCn", "cbOnline"])
    if (typeof prefs[key] === "boolean") $(key).checked = prefs[key];
  trainer.configureSpeech(prefs.speech);
} catch {
  applyTheme("white");
}
const synchronize = coalesceSync(async (options) => {
  await refresh(options);
  await flushOutbox(options);
  if (state.known && state.user) {
    await learning.flush(options);
    try {
      await learning.refresh();
    } catch (error) {
      if (error.code !== "STALE_ACCOUNT") {
        state.learningError = errorText(error);
        syncLabel();
      }
    }
    if (state.view === "history") await loadHistory();
    if (state.view === "review") await loadReviews();
    if (state.view === "admin") await loadInvitations();
  }
});
$("syncButton").addEventListener("click", () =>
  safe(() => synchronize({ retryBlocked: true })),
);
$("authRetryButton").addEventListener("click", () => safe(() => synchronize()));
window.addEventListener("online", () => safe(() => synchronize()));
window.addEventListener("focus", () => safe(() => synchronize()));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) safe(() => synchronize());
});
setInterval(() => {
  // Identity is checked even while editing; refreshing never replaces a draft.
  if (!document.hidden && !state.busy) safe(() => synchronize());
}, 20000);
window.addEventListener("beforeunload", (e) => {
  if (editorDirty() || unpersistedResults.size || learning.memory.size) {
    e.preventDefault();
    e.returnValue = "";
  }
});
window.addEventListener("pagehide", () => {
  if (learning.active && !learning.frozen && !trainer.state.done)
    learning.capture(trainer.snapshot());
});
authMode("login");
await synchronize();
if (state.known && state.user) {
  await safe(route);
} else syncLabel();
