import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { openDatabase, Store } from "./store.mjs";
import { InvitationStore, invitationHooks } from "./invites.mjs";
import { InputError, makeBackup } from "../shared/words.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
function send(res, code, body) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}
const bufferedBody = Symbol("buffered-json-body");
async function readBody(req, limit = 3 * 1024 * 1024, parse = true) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || ""))
    throw new InputError("请使用 application/json", 415);
  if (Number(req.headers["content-length"]) > limit)
    throw new InputError("请求内容过大，请分批导入", 413);
  let raw = req[bufferedBody];
  if (raw === undefined) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new InputError("请求内容过大，请分批导入", 413);
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString("utf8");
  }
  if (!parse) return raw;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new InputError("请求体不是合法 JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new InputError("请求体必须是 JSON 对象");
  return data;
}
function localSecret(dataDir) {
  const file = path.join(dataDir, "auth-secret");
  try {
    fs.writeFileSync(file, randomBytes(48).toString("base64url"), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return fs.readFileSync(file, "utf8").trim();
}

export async function createApp(options = {}) {
  const dataDir = path.resolve(
    options.dataDir || process.env.DATA_DIR || path.join(ROOT, "data"),
  );
  const origin =
    options.origin ||
    process.env.APP_ORIGIN ||
    `http://127.0.0.1:${process.env.PORT || 3000}`;
  const production =
    options.production ?? process.env.NODE_ENV === "production";
  if (
    production &&
    (!process.env.BETTER_AUTH_SECRET || !origin.startsWith("https://"))
  )
    throw new Error("生产环境需配置 HTTPS APP_ORIGIN 和 BETTER_AUTH_SECRET");
  if (production && process.env.BETTER_AUTH_SECRET.length < 32)
    throw new Error("生产登录密钥至少需要 32 字符");
  const db = openDatabase(dataDir),
    trustedOrigins = [origin];
  if (
    !production &&
    ["127.0.0.1", "localhost"].includes(new URL(origin).hostname)
  ) {
    const alternate = new URL(origin);
    alternate.hostname =
      alternate.hostname === "localhost" ? "127.0.0.1" : "localhost";
    trustedOrigins.push(alternate.origin);
  }
  const secret =
    options.secret || process.env.BETTER_AUTH_SECRET || localSecret(dataDir);
  const invites = new InvitationStore(db, { secret });
  const authOptions = {
    ...invitationHooks(invites),
    appName: "KeyWord",
    database: db,
    baseURL: origin,
    secret,
    trustedOrigins,
    user: {
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "user",
          input: false,
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
    },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    advanced: {
      useSecureCookies: production,
      ipAddress: { ipAddressHeaders: ["x-keyword-client-ip"] },
      cookiePrefix: "keyword",
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 120,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 60, max: 5 },
      },
    },
    telemetry: { enabled: false },
  };
  let store, vite, auth;
  try {
    const migration = await getMigrations(authOptions);
    await migration.runMigrations();
    auth = betterAuth(authOptions);
    store = new Store(db, {
      seedFile: options.seedFile || path.join(ROOT, "seed/decks.json"),
      legacyFile: options.legacyFile || path.join(ROOT, "leaderboard.json"),
      ...(options.catalogFile ? { catalogFile: options.catalogFile } : {}),
    });
    if (options.dev) {
      const { createServer } = await import("vite");
      vite = await createServer({
        root: ROOT,
        server: { middlewareMode: true },
        appType: "spa",
      });
    }
  } catch (error) {
    db.close();
    throw error;
  }
  const publicDir = path.resolve(options.publicDir || path.join(ROOT, "dist")),
    allowedHosts = new Set(trustedOrigins.map((x) => new URL(x).host));
  async function getSession(req, res) {
    const { response, headers } = await auth.api.getSession({
      headers: new Headers({ cookie: req.headers.cookie || "" }),
      returnHeaders: true,
    });
    // Session renewal must reach the browser as well as the database.
    const cookies = headers.getSetCookie();
    if (cookies.length) res.setHeader("Set-Cookie", cookies);
    return response;
  }
  function checkAccount(req, user) {
    const expected = req.headers["x-keyword-user"];
    if (expected && expected !== user?.id)
      throw Object.assign(
        new InputError(
          user
            ? "账号状态已变化，请重新载入；未将数据写入其他账号"
            : "登录已过期，请重新登录原账号后继续同步",
          user ? 409 : 401,
        ),
        { code: user ? "ACCOUNT_CHANGED" : "SESSION_EXPIRED" },
      );
  }
  let databaseQueue = Promise.resolve();
  const exclusiveDatabase = (action) => {
    const result = databaseQueue.then(action);
    databaseQueue = result.catch(() => {});
    return result;
  };
  const handleApi = async (req, res, url, pathname) => {
    if (pathname.startsWith("/api/auth/")) {
      if (!["GET", "POST"].includes(req.method))
        throw new InputError("不支持的请求方法", 405);
      if (req.headers["x-keyword-user"])
        checkAccount(req, (await getSession(req, res))?.user);
      const body =
          req.method === "POST" ? await readBody(req, 65536, false) : undefined,
        headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (
          value &&
          ![
            "host",
            "content-length",
            "x-keyword-client-ip",
            "x-forwarded-for",
            "forwarded",
            "x-real-ip",
          ].includes(key)
        )
          headers.set(key, String(value));
      headers.set(
        "x-keyword-client-ip",
        req.socket.remoteAddress || "127.0.0.1",
      );
      const response = await auth.handler(
        new Request(origin + url.pathname + url.search, {
          method: req.method,
          headers,
          body,
        }),
      );
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        if (key !== "set-cookie") res.setHeader(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader("Set-Cookie", cookies);
      res.setHeader("Cache-Control", "no-store");
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (pathname === "/api/health" && req.method === "GET") {
      db.prepare("SELECT 1").get();
      send(res, 200, { ok: true });
      return;
    }
    const session = await getSession(req, res),
      user = session?.user;
    if (pathname === "/api/me" && req.method === "GET") {
      send(res, 200, {
        ok: true,
        user: user
          ? { id: user.id, name: user.name, email: user.email, role: user.role }
          : null,
      });
      return;
    }
    checkAccount(req, user);
    if (!user)
      throw Object.assign(new InputError("请先登录后使用词库和练习", 401), {
        code: "LOGIN_REQUIRED",
      });
    if (pathname.startsWith("/api/admin/")) {
      if (user.role !== "admin") throw new InputError("仅管理员可访问", 403);
      if (pathname === "/api/admin/invitations" && req.method === "GET") {
        send(res, 200, {
          ok: true,
          invitations: invites.list({ reveal: true }),
        });
        return;
      }
      if (pathname === "/api/admin/invitations" && req.method === "POST") {
        const body = await readBody(req, 16384);
        const invitation = invites.create({
          days: body.days ?? 7,
          label: body.label ?? "",
          createdBy: user.id,
        });
        send(res, 201, { ok: true, invitation });
        return;
      }
      const revoke = pathname.match(
        /^\/api\/admin\/invitations\/([a-zA-Z0-9_-]{1,100})\/revoke$/,
      );
      if (revoke && req.method === "POST") {
        await readBody(req, 16384);
        send(res, 200, { ok: true, invitation: invites.revoke(revoke[1]) });
        return;
      }
      throw new InputError("管理接口不存在或请求方法不支持", 404);
    }
    if (pathname === "/api/catalog" && req.method === "GET") {
      send(res, 200, { ok: true, decks: store.list(null) });
      return;
    }
    // Historical anonymous records are read-only and now require login too.
    if (pathname === "/api/board" && req.method === "GET") {
      const bank = (url.searchParams.get("bank") || "").slice(0, 60),
        all = store.legacyDump(),
        rows = Object.hasOwn(all, bank) ? all[bank] : [];
      send(res, 200, {
        ok: true,
        bank,
        board: rows
          .slice()
          .sort((a, b) => a.time - b.time)
          .slice(0, 20),
        total: rows.length,
        readOnly: true,
      });
      return;
    }
    if (pathname === "/api/dump" && req.method === "GET") {
      send(res, 200, {
        ok: true,
        savedAt: Date.now(),
        data: store.legacyDump(),
        readOnly: true,
      });
      return;
    }
    if (pathname === "/api/score")
      throw new InputError(
        "历史匿名排行榜已只读；新练习请保存到账号练习记录",
        410,
      );
    if (pathname.startsWith("/api/")) {
      const deckMatch = pathname.match(
        /^\/api\/decks\/([a-zA-Z0-9_-]{1,100})(?:\/(restore))?$/,
      );
      if (deckMatch && req.method === "GET") {
        send(res, 200, {
          ok: true,
          deck: store.get(deckMatch[1], user?.id || null),
        });
        return;
      }
      if (pathname === "/api/learning" && req.method === "GET") {
        send(res, 200, {
          ok: true,
          summary: store.learning.read(user.id, "summary"),
        });
        return;
      }
      if (pathname === "/api/learning/reviews" && req.method === "GET") {
        send(res, 200, {
          ok: true,
          reviews: store.learning.read(user.id, "reviews"),
        });
        return;
      }
      if (pathname === "/api/learning/rounds" && req.method === "POST") {
        send(res, 201, {
          ok: true,
          round: store.learning.write(user.id, "start", await readBody(req)),
        });
        return;
      }
      const learningRound = pathname.match(
        /^\/api\/learning\/rounds\/([a-zA-Z0-9_-]{1,100})(?:\/(claim|checkpoint|retry|fork))?$/,
      );
      if (learningRound && req.method === "GET" && !learningRound[2]) {
        send(res, 200, {
          ok: true,
          round: store.learning.read(user.id, "round", learningRound[1]),
        });
        return;
      }
      if (learningRound && req.method === "POST" && learningRound[2]) {
        send(res, 200, {
          ok: true,
          round: store.learning.write(
            user.id,
            learningRound[2],
            learningRound[1],
            await readBody(req),
          ),
        });
        return;
      }
      const learningReview = pathname.match(
        /^\/api\/learning\/reviews\/([a-zA-Z0-9_-]{1,100})$/,
      );
      if (learningReview && req.method === "PUT") {
        send(res, 200, {
          ok: true,
          review: store.learning.write(
            user.id,
            "reviewAction",
            learningReview[1],
            await readBody(req),
          ),
        });
        return;
      }
      if (pathname === "/api/decks" && req.method === "GET") {
        send(res, 200, {
          ok: true,
          decks: store.list(user.id, url.searchParams.get("trash") === "1"),
        });
        return;
      }
      if (pathname === "/api/decks" && req.method === "POST") {
        send(res, 201, {
          ok: true,
          deck: store.create(user.id, await readBody(req)),
        });
        return;
      }
      if (pathname === "/api/decks/import" && req.method === "POST") {
        const body = await readBody(req);
        send(res, 201, {
          ok: true,
          decks: store.import(user.id, body.decks, body.operationId),
        });
        return;
      }
      if (deckMatch && req.method === "PUT" && !deckMatch[2]) {
        send(res, 200, {
          ok: true,
          deck: store.update(user.id, deckMatch[1], await readBody(req)),
        });
        return;
      }
      if (
        deckMatch &&
        (req.method === "DELETE" || (req.method === "POST" && deckMatch[2]))
      ) {
        send(res, 200, {
          ok: true,
          deck: store.trash(
            user.id,
            deckMatch[1],
            (await readBody(req)).version,
            !!deckMatch[2],
          ),
        });
        return;
      }
      if (pathname === "/api/sessions" && req.method === "GET") {
        send(res, 200, { ok: true, sessions: store.sessions(user.id) });
        return;
      }
      if (pathname === "/api/sessions" && req.method === "POST") {
        send(res, 201, {
          ok: true,
          session: store.saveSession(user.id, await readBody(req)),
        });
        return;
      }
      if (pathname === "/api/export" && req.method === "GET") {
        const decks = [
          ...store.list(user.id),
          ...store.list(user.id, true),
        ].map((d) => store.get(d.id, user.id, { includeDeleted: true }));
        send(res, 200, {
          ...makeBackup(decks, store.sessions(user.id, true)),
          learning: store.learning.export(user.id),
        });
        return;
      }
      throw new InputError("接口不存在或请求方法不支持", 404);
    }
  };
  const handle = async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Request-Id", requestId);
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'${options.dev ? " 'unsafe-inline'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data: https://dict.youdao.com; connect-src 'self'${options.dev ? " ws: wss:" : ""}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    );
    if (production)
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    try {
      if (!allowedHosts.has(req.headers.host))
        throw new InputError("访问地址未配置，请检查 APP_ORIGIN", 421);
      const url = new URL(req.url, origin);
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        throw new InputError("URL 编码无效");
      }
      if (
        pathname.includes("\0") ||
        pathname.includes("\\") ||
        pathname.split("/").some((s) => s === "." || s === "..")
      )
        throw new InputError("无效路径");
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
      if (
        mutating &&
        (!trustedOrigins.includes(req.headers.origin) ||
          req.headers["sec-fetch-site"] === "cross-site")
      )
        throw new InputError("请求来源不受信任", 403);
      if (pathname.startsWith("/api/")) {
        // Read bounded bodies before taking the DB gate; slow uploads must not
        // block login, checkpoint uploads or library reads.
        const authBody =
          pathname.startsWith("/api/auth/") && req.method === "POST";
        const dataBody =
          ["POST", "PUT", "DELETE"].includes(req.method) &&
          ["/api/decks", "/api/learning", "/api/sessions", "/api/admin"].some(
            (prefix) => pathname.startsWith(prefix),
          );
        if (authBody || dataBody)
          req[bufferedBody] = await readBody(
            req,
            authBody
              ? 65536
              : pathname.startsWith("/api/admin/")
                ? 16384
                : 3 * 1024 * 1024,
            false,
          );
        return await exclusiveDatabase(() =>
          handleApi(req, res, url, pathname),
        );
      }
      if (!["GET", "HEAD"].includes(req.method))
        throw new InputError("不支持的请求方法", 405);
      if (vite) {
        vite.middlewares(req, res, () =>
          send(res, 404, { error: "页面不存在" }),
        );
        return;
      }
      // Only built assets are public; never serve repository files or follow external symlinks.
      const relative =
        pathname === "/" || pathname === "/index.html"
          ? "index.html"
          : pathname.slice(1);
      if (!(
        relative === "index.html" || /^assets\/[a-zA-Z0-9_.-]+$/.test(relative)
      ))
        throw new InputError("文件不存在", 404);
      let file;
      try {
        file = fs.realpathSync(path.join(publicDir, relative));
      } catch {
        throw new InputError("文件不存在，请先运行 npm run build", 404);
      }
      if (
        !file.startsWith(fs.realpathSync(publicDir) + path.sep) ||
        !fs.statSync(file).isFile()
      )
        throw new InputError("文件不存在", 404);
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
        "Cache-Control":
          relative === "index.html"
            ? "no-cache"
            : "public,max-age=31536000,immutable",
      });
      if (req.method === "HEAD") res.end();
      else res.end(fs.readFileSync(file));
    } catch (error) {
      const status = error instanceof InputError ? error.status : 500;
      if (status === 500)
        console.error(
          `[${requestId}]`,
          error.code || error.name,
          error.message,
        );
      if (!res.headersSent)
        send(res, status, {
          ok: false,
          error:
            status === 500
              ? "保存或读取失败，尚未确认写入。请重试。"
              : error.message,
          requestId,
          ...(error instanceof InputError && error.code
            ? { code: error.code }
            : {}),
        });
      else res.end();
    }
  };
  const server = http.createServer(handle);
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return {
    server,
    store,
    db,
    auth,
    invites,
    origin,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await vite?.close();
      db.close();
    },
  };
}

export async function start() {
  const dev = process.argv.includes("--dev"),
    host = process.env.HOST || "127.0.0.1",
    port = Number(process.env.PORT || 3000);
  if (dev && !["127.0.0.1", "localhost"].includes(host))
    throw new Error("开发模式仅允许本机访问；跨设备请使用构建后的服务");
  const app = await createApp({ dev });
  app.server.listen(port, host, () => console.log(`KeyWord: ${app.origin}`));
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      app.close().then(() => process.exit(0));
    });
  return app;
}
