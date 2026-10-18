/* KEYSTROKE 排行榜数据备份脚本（零依赖，Node >= 18 用全局 fetch）
 *
 * 背景：如果你把本服务部署到「每次重新部署都会重置工作目录」的平台
 * （某些 Serverless / 沙箱托管就是这样），不先拉回线上数据就重发
 * = 历史成绩全部丢失。本脚本在重发前把线上数据拉回本地兜底。
 *
 * 用法（在项目根目录执行）：
 *   node tools/board-backup.js pull                      拉取本地服务全量数据 → 写本地备份 + 数据文件
 *   node tools/board-backup.js pull https://你的域名       指定线上地址
 *   node tools/board-backup.js stage                      只把本地备份写回数据文件（不联网）
 *   node tools/board-backup.js status                     查看本地备份与数据文件的状态
 *
 * 标准重发流程（部署到会重置数据的平台时，每次重发前必做）：
 *   1) node tools/board-backup.js pull https://你的域名   （线上数据 → 本地备份 + leaderboard.json）
 *   2) 正常重新部署                                        （leaderboard.json 随目录一起上传，数据不丢）
 *
 * 也可以配一个每日自动备份（只 pull 不发布），双保险。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BACKUP_FILE = path.join(ROOT, "leaderboard.backup.json");
const STAGE_FILE = path.join(ROOT, "leaderboard.json");
const DEFAULT_BASE = "http://127.0.0.1:3000";

function info(o) { console.log(o); }

function summarize(data) {
  const keys = Object.keys(data || {});
  if (!keys.length) return "（空数据，没有任何词库有成绩）";
  const total = keys.reduce(function (n, k) { return n + (data[k] || []).length; }, 0);
  return keys.map(function (k) {
    return k + "(" + (data[k] || []).length + ")";
  }).join(" ") + " ｜ 共 " + keys.length + " 个词库 " + total + " 条";
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch (e) { return null; }
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
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
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
  info("  下一步：重新部署即可，leaderboard.json 会随目录一起上传，数据不丢。");
}

function stage() {
  const d = readJSON(BACKUP_FILE);
  if (!isPlainData(d)) {
    info("✗ 没有可用的本地备份（leaderboard.backup.json 不存在或格式不对）");
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(STAGE_FILE), { recursive: true });
  fs.writeFileSync(STAGE_FILE, JSON.stringify(d), "utf-8");
  info("✓ 已写回 leaderboard.json");
  info("  数据概览：" + summarize(d));
}

function status() {
  const b = readJSON(BACKUP_FILE);
  const s = readJSON(STAGE_FILE);
  info("本地备份 leaderboard.backup.json：" + (b ? summarize(b) : "不存在") +
    (b && fs.existsSync(BACKUP_FILE) ? "（" + fs.statSync(BACKUP_FILE).mtime.toLocaleString("zh-CN") + " 更新）" : ""));
  info("数据文件 leaderboard.json：" + (s ? summarize(s) : "不存在"));
}

const cmd = process.argv[2] || "status";
const base = process.argv[3] || DEFAULT_BASE;
if (cmd === "pull") pull(base);
else if (cmd === "stage") stage();
else if (cmd === "status") status();
else { info("未知命令：" + cmd + "（可用：pull / stage / status）"); process.exit(1); }
