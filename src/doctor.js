import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { semanticModelStatus } from "./semantic-model.js";

const require = createRequire(import.meta.url);

export function doctor() {
  const home = os.homedir();
  const checks = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "Node.js >=22", ok: major >= 22, detail: process.version });
  checks.push({ name: "SQLite", ok: testSqlite(), detail: "node:sqlite" });
  const vector = testVectorRuntime();
  checks.push({ name: "Semantic vector runtime", ok: vector.ok, detail: vector.detail });
  const model = semanticModelStatus({ deep: false });
  checks.push({ name: "Default semantic model", ok: model.available, detail: model.available ? `${model.modelId}@${model.revision}; ${model.snapshotPath}` : `not installed; optional; ${model.snapshotPath}` });
  checks.push({ name: "Zstandard", ok: typeof zlib.createZstdDecompress === "function", detail: typeof zlib.createZstdDecompress === "function" ? "node:zlib" : "requires external zstd binary" });
  for (const [name, target] of [
    ["Codex home", process.env.CODEX_HOME || path.join(home, ".codex")],
    ["Claude home", path.join(home, ".claude")],
    ["Antigravity home", path.join(home, ".gemini", "antigravity")],
  ]) checks.push({ name, ok: fs.existsSync(target), detail: target });
  return checks;
}

function testVectorRuntime() {
  let db;
  try {
    const sqliteVec = require("sqlite-vec");
    db = new DatabaseSync(":memory:", { allowExtension: true });
    db.enableLoadExtension(true);
    sqliteVec.load(db);
    const version = db.prepare("SELECT vec_version() version").get().version;
    return { ok: true, detail: `sqlite-vec ${version}` };
  } catch (error) {
    return { ok: false, detail: `optional local semantic runtime unavailable: ${error.message || error}` };
  } finally { db?.close(); }
}

function testSqlite() {
  try {
    const db = new DatabaseSync(":memory:");
    const value = db.prepare("SELECT 1 n").get().n;
    db.close();
    return value === 1;
  } catch { return false; }
}
