import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { createPractice } from "../src/practice.mjs";
import { targetFor, newId } from "../shared/words.mjs";

const execute = promisify(execFile),
  name = "keyword-smoke-" + process.pid;
const origin = "https://keyword.example.test",
  password = randomBytes(20).toString("base64url");
const docker = async (...args) => (await execute("docker", args)).stdout.trim();
let port;
function call(url, body, cookie = "") {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: url,
        method: raw === undefined ? "GET" : "POST",
        timeout: 10000,
        headers: {
          Host: new URL(origin).host,
          Origin: origin,
          Cookie: cookie,
          Connection: "close",
          ...(raw === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(raw),
              }),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
          resolve({
            status: res.statusCode,
            data,
            cookie: (res.headers["set-cookie"] || [])
              .map((x) => x.split(";")[0])
              .join("; "),
          });
        });
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error("Container request timed out")),
    );
    req.on("error", reject);
    req.end(raw);
  });
}
async function ready() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await call("/api/health")).data.ok) return;
    } catch {}
    await sleep(400);
  }
  throw new Error("Container did not become healthy");
}
try {
  await docker(
    "run",
    "-d",
    "--name",
    name,
    "--read-only",
    "--tmpfs",
    "/tmp:noexec,nosuid,size=16m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "-p",
    "127.0.0.1::3000",
    "-e",
    "APP_ORIGIN=" + origin,
    "-e",
    "BETTER_AUTH_SECRET=" + randomBytes(48).toString("base64url"),
    process.argv[2] || "keyword-ci:smoke",
  );
  port = Number((await docker("port", name, "3000/tcp")).split(":").at(-1));
  await ready();
  await docker("exec", name, "node", "tools/healthcheck.mjs");
  assert.equal(
    await docker("inspect", "--format", "{{.Config.User}}", name),
    "node",
  );
  for (const route of [
    "/api/catalog",
    "/api/decks/builtin-ecdict-gre",
    "/api/sessions",
    "/api/admin/invitations",
    "/api/dump",
  ])
    assert.equal((await call(route)).status, 401, route);
  const page = await call("/");
  assert.equal(page.status, 200);
  assert.match(page.data, /id="authGate"/);
  const bootstrap = await docker(
    "exec",
    name,
    "node",
    "tools/invite.mjs",
    "create",
    "--admin",
  );
  const code = bootstrap.match(/KW-(?:[A-F0-9]{8}-){4}[A-F0-9]{8}/)?.[0];
  assert.ok(code);
  const admin = await call("/api/auth/sign-up/email", {
    name: "Owner",
    email: "owner@example.test",
    password,
    inviteCode: code,
  });
  assert.equal(admin.status, 200, JSON.stringify(admin.data));
  assert.equal(
    (await call("/api/me", undefined, admin.cookie)).data.user.role,
    "admin",
  );
  const invite = (
    await call("/api/admin/invitations", { label: "CI friend" }, admin.cookie)
  ).data.invitation;
  assert.ok(invite.code);
  const user = await call("/api/auth/sign-up/email", {
    name: "Friend",
    email: "friend@example.test",
    password,
    inviteCode: invite.code,
  });
  assert.equal(user.status, 200);
  assert.equal(
    (await call("/api/admin/invitations", undefined, user.cookie)).status,
    403,
  );
  assert.equal(
    (await call("/api/admin/invitations", {}, user.cookie)).status,
    403,
  );
  assert.equal(
    (await call("/api/catalog", undefined, user.cookie)).data.decks.length,
    10,
  );
  const saved = await call(
    "/api/decks",
    { title: "Persistent CI deck", words: [{ term: "safe", meaning: "安全" }] },
    user.cookie,
  );
  assert.equal(saved.status, 201);
  const round = (
    await call(
      "/api/learning/rounds",
      { deckId: saved.data.deck.id, operationId: newId() },
      user.cookie,
    )
  ).data.round;
  const engine = createPractice({ clock: () => 0 });
  engine.restore(
    {
      id: round.scopeId,
      title: round.title,
      version: round.deckVersion,
      words: round.words,
    },
    round.checkpoint,
    round.id,
  );
  for (const word of round.words)
    for (const ch of targetFor(word.term)) engine.input(ch);
  assert.equal(
    (
      await call(
        `/api/learning/rounds/${round.id}/checkpoint`,
        {
          generation: round.generation,
          sequence: 1,
          checkpoint: engine.snapshot(),
        },
        user.cookie,
      )
    ).status,
    200,
  );
  const pending = (
    await call(
      "/api/admin/invitations",
      { label: "Keep after restart" },
      admin.cookie,
    )
  ).data.invitation;
  await docker("exec", name, "node", "tools/backup.mjs");
  await docker("restart", name);
  // Docker can reassign an automatically published host port on restart.
  port = Number((await docker("port", name, "3000/tcp")).split(":").at(-1));
  await ready();
  assert.equal(
    (await call("/api/me", undefined, admin.cookie)).data.user.role,
    "admin",
  );
  assert.equal(
    (await call("/api/decks/" + saved.data.deck.id, undefined, user.cookie))
      .data.deck.title,
    "Persistent CI deck",
  );
  assert.equal(
    (await call("/api/sessions", undefined, user.cookie)).data.sessions.length,
    1,
  );
  const listed = (await call("/api/admin/invitations", undefined, admin.cookie))
    .data.invitations;
  assert.equal(listed.find((x) => x.id === pending.id).code, pending.code);
  assert.equal(
    (
      await call(
        `/api/admin/invitations/${pending.id}/revoke`,
        {},
        admin.cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call("/api/auth/sign-up/email", {
        name: "Denied",
        email: "denied@example.test",
        password,
        inviteCode: pending.code,
      })
    ).status,
    403,
  );
  const device = await call("/api/auth/sign-in/email", {
    email: "friend@example.test",
    password,
  });
  assert.equal(device.status, 200);
  assert.equal(
    (await call("/api/sessions", undefined, device.cookie)).data.sessions
      .length,
    1,
  );
  console.log(
    "Container verified: non-root, read-only filesystem, login gate, admin isolation, invitations, persistent library and learning history after restart.",
  );
} catch (error) {
  const logs = await docker("logs", name).catch(() => "");
  console.error(logs);
  throw error;
} finally {
  await docker("rm", "-fv", name).catch(() => {});
}
