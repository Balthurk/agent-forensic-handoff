import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, hashFile, walkFiles } from "./util.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_SOURCE = path.resolve(MODULE_DIR, "..", "skills", "agent-forensic-handoff");

export function installTargets(target, explicitPath = null) {
  const home = os.homedir();
  const targets = {
    codex: path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "skills", "agent-forensic-handoff"),
    claude: path.join(home, ".claude", "skills", "agent-forensic-handoff"),
    antigravity: path.join(home, ".gemini", "antigravity", "skills", "agent-forensic-handoff"),
    generic: explicitPath ? path.resolve(explicitPath) : null,
  };
  if (target === "all") return [targets.codex, targets.claude, targets.antigravity];
  if (!targets[target]) throw new Error(target === "generic" ? "--path is required for a generic target" : `Unknown install target: ${target}`);
  return [targets[target]];
}

export async function installSkill({ target = "codex", explicitPath = null, force = false } = {}) {
  if (!fs.existsSync(SKILL_SOURCE)) throw new Error(`Bundled skill not found: ${SKILL_SOURCE}`);
  const results = [];
  for (const destination of installTargets(target, explicitPath)) {
    ensureDir(path.dirname(destination));
    if (fs.existsSync(destination)) {
      const same = await treesEqual(SKILL_SOURCE, destination);
      if (same) { results.push({ destination, status: "UNCHANGED" }); continue; }
      if (!force) throw new Error(`Skill already exists with different content: ${destination}. Re-run with --force to replace that exact skill folder.`);
      fs.rmSync(destination, { recursive: true, force: true });
    }
    fs.cpSync(SKILL_SOURCE, destination, { recursive: true, force: false, errorOnExist: true });
    results.push({ destination, status: "INSTALLED" });
  }
  return results;
}

async function treesEqual(left, right) {
  const rel = (root) => walkFiles(root).map((file) => path.relative(root, file).replaceAll(path.sep, "/"));
  const a = rel(left);
  const b = rel(right);
  if (JSON.stringify(a) !== JSON.stringify(b)) return false;
  for (const file of a) if (await hashFile(path.join(left, file)) !== await hashFile(path.join(right, file))) return false;
  return true;
}
