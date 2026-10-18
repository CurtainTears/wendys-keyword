/* KEYSTROKE 打字训练器 —— 零依赖 Node 后端
   同时托管静态文件（index.html / words.txt 等）与排行榜 API。
   排行榜数据存本地 JSON 文件，应用内持久化（平台沙箱保留工作目录即可长期保存）。 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, "leaderboard.json");
const TOP_N = 20;          // 榜单对外只显示前 20
const KEEP_N = 200;        // 每个词库服务端多存一些，便于去重与扩容
const NAME_MAX = 16;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

/* ---------- 数据层 ---------- */
function loadData() {
  try {
    const t = fs.readFileSync(DATA_FILE, "utf-8");
    const o = JSON.parse(t);
    if (o && typeof o === "object" && !Array.isArray(o)) return o;
  } catch (e) {}
  return {};
}
let DATA = loadData();
function saveData() {
  try {
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(DATA), "utf-8");
    fs.renameSync(tmp, DATA_FILE);   // 原子替换，避免写到一半被读
  } catch (e) {}
}
function normName(s) {
  if (typeof s !== "string") return "";
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 32 || c === 127) continue;   // 去掉控制字符
    out += ch;
  }
  out = out.replace(/[ \t]+/g, " ").trim(); // 折叠空白
  return out.slice(0, NAME_MAX);
}
function boardFor(bank) {
  const arr = DATA[bank] || [];
  return arr.slice().sort(function (a, b) { return a.time - b.time; });
}

/* ---------- 静态文件 ---------- */
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  const fp = path.normalize(path.join(ROOT, rel));
  if (fp.indexOf(ROOT) !== 0) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(fp, function (err, buf) {
    if (err) { res.writeHead(404, {"Content-Type":"text/plain; charset=utf-8"}); res.end("404 not found"); return; }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, {"Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache"});
    res.end(buf);
  });
}

/* ---------- API ---------- */
function sendJSON(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, {"Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"});
  res.end(b);
}
function readBody(req, cb) {
  let d = "";
  req.on("data", function (c) { d += c; if (d.length > 1e6) req.destroy(); });
  req.on("end", function () { try { cb(null, JSON.parse(d || "{}")); } catch (e) { cb(e); } });
}

/* 全量导出：备份专用。沙箱数据在重新发布时会被重置，发布前必须先把
   线上数据拉回本地（见 tools/board-backup.js），否则历史成绩全部丢失。 */
function handleDump(req, res) {
  sendJSON(res, 200, { ok: true, savedAt: Date.now(), data: DATA });
}

function handleBoard(req, res, q) {
  const bank = (q.get("bank") || "").toString().slice(0, 60);
  const board = boardFor(bank).slice(0, TOP_N).map(function (x) {
    return { name: x.name, time: x.time, acc: x.acc, combo: x.combo, date: x.date };
  });
  sendJSON(res, 200, { ok: true, bank: bank, board: board, total: (DATA[bank] || []).length });
}
function handleScore(req, res) {
  readBody(req, function (err, body) {
    if (err) { sendJSON(res, 400, { ok:false, error:"请求体不是合法 JSON" }); return; }
    const bank = String(body.bank || "").slice(0, 60);
    const name = normName(body.name);
    const time = Number(body.time);
    /* null/undefined 要当「没提供」处理：Number(null)===0，不拦一下会把缺失的准确率存成 0% */
    const acc = (body.acc == null) ? NaN : Number(body.acc);
    const combo = (body.combo == null) ? NaN : Number(body.combo);
    const accOk = Number.isFinite(acc) && acc>=0 && acc<=100;
    const comboOk = Number.isInteger(combo) && combo>=0 && combo<1e6;
    if (!bank) { sendJSON(res, 400, { ok:false, error:"缺少词库标识" }); return; }
    if (!name) { sendJSON(res, 400, { ok:false, error:"昵称不能为空" }); return; }
    if (!(time > 0) || !(time < 1e6)) { sendJSON(res, 400, { ok:false, error:"成绩（用时）非法" }); return; }
    const rtime = Math.round(time*10)/10;
    const racc = accOk ? Math.round(acc) : null;
    const rcombo = comboOk ? combo : null;
    const now = new Date();
    const date = now.getFullYear() + "-" + String(now.getMonth()+1).padStart(2,"0") + "-" + String(now.getDate()).padStart(2,"0");
    const nowTs = now.getTime();
    const arr = DATA[bank] || (DATA[bank] = []);
    const low = name.toLowerCase();
    const ex = arr.find(function (x) { return x.name.toLowerCase() === low; });
    if (ex) {
      // 同昵称：更新最好成绩（用时取更短，准确率/连击各取各自最大值；新成绩缺某项则不覆盖旧值）
      ex.time  = Math.min(ex.time, rtime);
      ex.acc   = (racc==null) ? (ex.acc||null)   : Math.max(ex.acc||0, racc);
      ex.combo = (rcombo==null) ? (ex.combo||null) : Math.max(ex.combo||0, rcombo);
      ex.date  = date; ex.ts = nowTs;
    } else {
      arr.push({ name:name, time:rtime, acc:racc, combo:rcombo, date:date, ts:nowTs });
    }
    arr.sort(function (a, b) { return a.time - b.time; });
    if (arr.length > KEEP_N) arr.length = KEEP_N;
    saveData();
    const board = arr.slice(0, TOP_N).map(function (x) { return { name:x.name, time:x.time, acc:x.acc, combo:x.combo, date:x.date }; });
    sendJSON(res, 200, { ok:true, bank:bank, board:board, total: arr.length });
  });
}

/* ---------- 路由 ---------- */
const server = http.createServer(function (req, res) {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;
  if (p === "/api/board") { handleBoard(req, res, u.searchParams); return; }
  if (p === "/api/score") { handleScore(req, res); return; }
  if (p === "/api/dump") { handleDump(req, res); return; }
  serveStatic(req, res, p);
});
server.listen(PORT, "0.0.0.0", function () {
  console.log("KEYSTROKE server listening on 0.0.0.0:" + PORT);
});
