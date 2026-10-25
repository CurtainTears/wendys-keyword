/* 历史匿名排行榜导出工具。仅处理 /api/dump 与旧版 JSON 模板。
 * 不包含 2.0 账号、私人词库、练习记录。整站备份请运行 npm run backup。
 * pull [base]：导出历史榜单到本地；stage：写回首次初始化使用的旧模板；status：查看。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BACKUP_FILE = path.join(ROOT, "leaderboard.backup.json");
const STAGE_FILE = path.join(ROOT, "leaderboard.json");
const DEFAULT_BASE = "http://127.0.0.1:3000";

function info(o) {
  console.log(o);
}

function summarize(data) {
  const keys = Object.keys(data || {});
  if (!keys.length) return "（空数据，没有任何词库有成绩）";
  const total = keys.reduce(function (n, k) {
    return n + (data[k] || []).length;
  }, 0);
  return (
    keys
      .map(function (k) {
        return k + "(" + (data[k] || []).length + ")";
      })
      .join(" ") +
    " ｜ 共 " +
    keys.length +
    " 个词库 " +
    total +
    " 条"
  );
}

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    return null;
  }
}

function isPlainData(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  for (const k of Object.keys(o)) {
    if (!Array.isArray(o[k])) return false;
  }
  return true;
}

async function pull(base) {
  const url = base.replace(/\/+$/, "") + "/api/dump";
  info("拉取 " + url + " ...");
  let j;
  try {
    const r = await fetch(url, {
      headers: { Cookie: process.env.KEYWORD_SESSION_COOKIE || "" },
      signal: AbortSignal.timeout(20000),
    });
    if (r.status === 401)
      throw new Error(
        "需要登录会话：请设置 KEYWORD_SESSION_COOKIE；整站备份推荐 npm run backup",
      );
    if (!r.ok) throw new Error("HTTP " + r.status);
    j = await r.json();
  } catch (e) {
    info("✗ 拉取失败：" + e.message + "（保留本地现有备份，未做任何修改）");
    process.exit(1);
  }
  if (!j || j.ok !== true || !isPlainData(j.data)) {
    info("✗ 返回数据格式不正确（保留本地现有备份，未做任何修改）");
    process.exit(1);
  }
  /* 先写备份文件，成功后再暂存——任何一步写盘失败都不留下半成品 */
  const text = JSON.stringify(j.data);
  fs.writeFileSync(BACKUP_FILE, text, "utf-8");
  fs.mkdirSync(path.dirname(STAGE_FILE), { recursive: true });
  fs.writeFileSync(STAGE_FILE, text, "utf-8");
  info("✓ 已备份到 leaderboard.backup.json 并写回 leaderboard.json");
  info("  数据概览：" + summarize(j.data));
  info(
    "  仅备份历史匿名榜单。账号与词库请使用 npm run backup，部署时保留 DATA_DIR。",
  );
}

function stage() {
  const d = readJSON(BACKUP_FILE);
  if (!isPlainData(d)) {
    info("✗ 没有可用的本地备份（leaderboard.backup.json 不存在或格式不对）");
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(STAGE_FILE), { recursive: true });
  fs.writeFileSync(STAGE_FILE, JSON.stringify(d), "utf-8");
  info(
    "✓ 已写回旧版导入模板 leaderboard.json（只在新数据库首次初始化时使用，不覆盖现有数据库）",
  );
  info("  数据概览：" + summarize(d));
}

function status() {
  const b = readJSON(BACKUP_FILE);
  const s = readJSON(STAGE_FILE);
  info(
    "本地备份 leaderboard.backup.json：" +
      (b ? summarize(b) : "不存在") +
      (b && fs.existsSync(BACKUP_FILE)
        ? "（" +
          fs.statSync(BACKUP_FILE).mtime.toLocaleString("zh-CN") +
          " 更新）"
        : ""),
  );
  info("数据文件 leaderboard.json：" + (s ? summarize(s) : "不存在"));
}

const cmd = process.argv[2] || "status";
const base = process.argv[3] || DEFAULT_BASE;
if (cmd === "pull") pull(base);
else if (cmd === "stage") stage();
else if (cmd === "status") status();
else {
  info("未知命令：" + cmd + "（可用：pull / stage / status）");
  process.exit(1);
}
