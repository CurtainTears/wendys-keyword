import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../server/store.mjs";
import { InvitationStore } from "../server/invites.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2),
  command = args.shift();
const usage =
  "用法：npm run invite -- create [--admin] [--days 7] [--label 备注] | list | revoke <ID>";
let db;
try {
  if (!["create", "list", "revoke"].includes(command)) throw new Error(usage);
  const options = {};
  if (command === "create") {
    while (args.length) {
      const flag = args.shift();
      if (flag === "--admin" && options[flag] === undefined) {
        options[flag] = true;
        continue;
      }
      const value = args.shift();
      if (
        !["--days", "--label"].includes(flag) ||
        value === undefined ||
        options[flag] !== undefined
      )
        throw new Error(usage);
      options[flag] = value;
    }
  } else if (
    (command === "list" && args.length) ||
    (command === "revoke" && args.length !== 1)
  )
    throw new Error(usage);
  db = openDatabase(
    path.resolve(process.env.DATA_DIR || path.join(root, "data")),
  );
  const invitations = new InvitationStore(db);
  if (command === "create") {
    const created = invitations.create({
      days: options["--days"] === undefined ? 7 : Number(options["--days"]),
      label: options["--label"] || "",
      role: options["--admin"] ? "admin" : "user",
    });
    console.log(
      `邀请码：${created.code}\n权限：${created.role === "admin" ? "管理员（仅交给服务所有者）" : "普通账号"}\n管理 ID：${created.id}\n有效期至：${new Date(created.expiresAt).toISOString()}（UTC）\n一次性使用。此命令只保存散列，请通过私密渠道交给受邀者。`,
    );
  } else if (command === "list") {
    const labels = {
      available: "可使用",
      used: "已使用",
      expired: "已过期",
      revoked: "已撤销",
      suspended: "退款核对中",
    };
    const rows = invitations.list().map((r) => ({
      ID: r.id,
      备注: r.label,
      状态: labels[r.status],
      权限: r.role === "admin" ? "管理员" : "普通账号",
      有效期UTC:
        r.expiresAt === null
          ? "长期有效（未使用前）"
          : new Date(r.expiresAt).toISOString(),
      使用邮箱: r.usedEmail || "",
    }));
    if (rows.length) console.table(rows);
    else console.log("暂无邀请码。未持有有效邀请码的用户不能注册。");
  } else {
    const revoked = invitations.revoke(args[0]);
    console.log(`已撤销邀请码 ${revoked.id}。已有账号不受影响。`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
