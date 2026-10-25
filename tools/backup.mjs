import { backup } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(
  path.resolve(process.env.DATA_DIR || path.join(root, "data")),
  "keyword.sqlite",
);
if (!fs.existsSync(source)) throw new Error("数据库不存在，请先启动应用");
const directory = path.resolve(
  process.env.BACKUP_DIR || path.join(root, "backups"),
);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const target = path.resolve(
  process.argv[2] ||
    path.join(
      directory,
      `keyword-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`,
    ),
);
const fd = fs.openSync(target, "wx", 0o600);
fs.closeSync(fd);
const db = new DatabaseSync(source, { readOnly: true });
try {
  await backup(db, target);
  const check = new DatabaseSync(target, { readOnly: true });
  try {
    if (check.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
      throw new Error("备份数据库完整性检查失败");
  } finally {
    check.close();
  }
  console.log(`已备份：${target}`);
  console.log(
    "此文件包含账号、词库、历史版本和练习记录，请妥善保管。生产环境的登录密钥需另行安全保存。",
  );
} finally {
  db.close();
}
