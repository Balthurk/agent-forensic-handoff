import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";

export function doctor() {
  const home = os.homedir();
  const checks = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "Node.js >=22", ok: major >= 22, detail: process.version });
  checks.push({ name: "SQLite", ok: testSqlite(), detail: "node:sqlite" });
  checks.push({ name: "Zstandard", ok: typeof zlib.createZstdDecompress === "function", detail: typeof zlib.createZstdDecompress === "function" ? "node:zlib" : "requires external zstd binary" });
  for (const [name, target] of [
    ["Codex home", process.env.CODEX_HOME || path.join(home, ".codex")],
    ["Claude home", path.join(home, ".claude")],
    ["Antigravity home", path.join(home, ".gemini", "antigravity")],
  ]) checks.push({ name, ok: fs.existsSync(target), detail: target });
  return checks;
}

function testSqlite() {
  try {
    const db = new DatabaseSync(":memory:");
    const value = db.prepare("SELECT 1 n").get().n;
    db.close();
    return value === 1;
  } catch { return false; }
}
