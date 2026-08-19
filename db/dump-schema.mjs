// 从现有 SQLite 库导出表结构（仅 DDL，无数据）。
// 用法：node db/dump-schema.mjs <源.sqlite> <输出.sql> [标题]
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";

const [src, out, title = src] = process.argv.slice(2);
const db = new DatabaseSync(src, { readOnly: true });
const rows = db
  .prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' " +
      "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name",
  )
  .all();
const body = rows.map((r) => `${String(r.sql).trim().replace(/;*\s*$/, "")};`).join("\n\n");
const header = `-- ${title}\n-- 仅结构，无数据。运行时由代码迁移自动建表，此文件用于查阅/审计。\n\n`;
writeFileSync(out, header + body + "\n");
console.log(out, rows.length, "objects");
db.close();
