import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SECRET_PATTERNS } from "./constants.js";

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object" && value.constructor === Object) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

export function shortHash(value, length = 16) {
  return sha256(typeof value === "string" ? value : stableStringify(value)).slice(0, length);
}

export function expandHome(input) {
  if (!input) return input;
  if (input === "~") return os.homedir();
  if (input.startsWith(`~${path.sep}`)) return path.join(os.homedir(), input.slice(2));
  return path.resolve(input);
}

export function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  try { fs.chmodSync(dir, mode); } catch {}
  return dir;
}

export function atomicWrite(filePath, value, mode = 0o600) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, value, { mode });
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, mode); } catch {}
}

export function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }
}

export function safeJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      return item.text ?? item.input_text ?? item.output_text ?? item.content ?? "";
    }).filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    return asText(value.text ?? value.message ?? value.content ?? value.output ?? "") || stableStringify(value);
  }
  return String(value);
}

export function redactText(input) {
  let text = asText(input);
  const findings = [];
  for (const [kind, pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, (match) => {
      findings.push({ kind, fingerprint: shortHash(match, 12) });
      return `[REDACTED:${kind}:${shortHash(match, 8)}]`;
    });
  }
  return { text, findings };
}

export function preview(input, maxChars = 1200) {
  const { text, findings } = redactText(input);
  const normalized = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n");
  if (normalized.length <= maxChars) return { text: normalized, findings, truncated: false };
  const head = Math.ceil(maxChars * 0.7);
  const tail = maxChars - head;
  return {
    text: `${normalized.slice(0, head)}\n…[${normalized.length - maxChars} chars omitted from projection; raw evidence retained]…\n${normalized.slice(-tail)}`,
    findings,
    truncated: true,
  };
}

export function normalizeTimestamp(value) {
  if (value == null || value === "") return { value: null, precision: "UNKNOWN" };
  if (typeof value === "number") {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.valueOf()) ? { value: null, precision: "UNKNOWN" } : { value: date.toISOString(), precision: "MILLISECOND" };
  }
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? { value: null, precision: "UNKNOWN" } : { value: date.toISOString(), precision: /[.][0-9]+/.test(String(value)) ? "MILLISECOND" : "SECOND" };
}

export function slug(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
}

export function walkFiles(root, predicate = () => true, limit = 200_000) {
  const result = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && predicate(full)) result.push(full);
      if (result.length >= limit) return result.sort();
    }
  }
  return result.sort();
}

export function runReadOnly(command, args, cwd, timeout = 15_000) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

export function parseCli(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) { positional.push(token); continue; }
    const eq = token.indexOf("=");
    if (eq !== -1) { flags[token.slice(2, eq)] = token.slice(eq + 1); continue; }
    const key = token.slice(2);
    if (key.startsWith("no-")) { flags[key.slice(3)] = false; continue; }
    const next = argv[i + 1];
    if (next != null && !next.startsWith("--")) { flags[key] = next; i += 1; }
    else flags[key] = true;
  }
  return { positional, flags };
}

export function boolFlag(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

export function tokenEstimate(text) {
  return Math.ceil(String(text || "").length / 4);
}

export function relativeOrAbsolute(target, root) {
  if (!target) return null;
  const absolute = path.resolve(target);
  const rel = root ? path.relative(root, absolute) : absolute;
  return root && rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.replaceAll(path.sep, "/") : absolute;
}
