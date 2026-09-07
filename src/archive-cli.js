import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { archiveRequest } from "./archive/engine.js";
import { boolFlag } from "./util.js";

const MUTATING = new Set(["archive.init", "archive.ingest", "archive.recover"]);
const OPERATIONS = new Map([
  ["init", "archive.init"], ["ingest", "archive.ingest"], ["verify", "archive.verify"],
  ["recover", "archive.recover"], ["show", "event.show"], ["stats", "stats"],
  ["evidence", "evidence.read"],
]);

function required(value, usage) { if (!value) throw new Error(`Usage: ${usage}`); return value; }
function readInput(ref, label) {
  if (!ref) return null;
  if (ref === "-" && process.stdin.isTTY) throw new Error(`${label} '-' requires piped stdin`);
  const bytes = ref === "-" ? fs.readFileSync(0) : fs.readFileSync(path.resolve(ref));
  if (bytes.length > 1024 * 1024) throw new Error(`${label} exceeds the 1 MiB CLI request limit`);
  const text = bytes.toString("utf8");
  try { return JSON.parse(text); } catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
}
function numberFlag(value, name) {
  if (value == null) return undefined;
  const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`--${name} must be a non-negative safe integer`); return parsed;
}
function inferOriginDomain(archive, harness) {
  let pointer;
  try { pointer = JSON.parse(fs.readFileSync(path.join(archive, "archive.json"), "utf8")); }
  catch { throw new Error("--origin-domain-id is required when archive.json cannot be read"); }
  const matches = (pointer.origin_domains || []).filter((item) => item.harness === harness);
  if (matches.length !== 1) throw new Error(`--origin-domain-id is required; found ${matches.length} '${harness}' origin domains`);
  return matches[0].id;
}
function suppliedParams(flags) { return readInput(flags.request || flags.params, "--request"); }

export function buildArchiveCliRequest(positional, flags) {
  const action = positional.shift() || "help";
  if (action === "request") {
    const request = readInput(required(flags.file, "afh archive request --file <request.json|->"), "--file");
    return { request, action };
  }
  const operation = OPERATIONS.get(action);
  if (!operation) throw new Error("Usage: afh archive init|ingest|verify|recover|show|stats|evidence|request ...");
  const archive = path.resolve(required(positional.shift(), `afh archive ${action} <archive> ...`));
  const provided = suppliedParams(flags);
  let params = provided;
  if (!params) {
    if (action === "init") {
      const id = String(flags["origin-domain-id"] || randomUUID());
      params = { idempotency_key: required(flags["idempotency-key"], "afh archive init <archive> --idempotency-key KEY [--origin-domain-id UUID]") };
      params.origin_domains = [{ id, harness: String(flags.harness || "generic"), descriptor: String(flags.descriptor || "AFH CLI archive source") }];
      if (flags["access-domain-id"]) params.access_domain_id = String(flags["access-domain-id"]);
    } else if (action === "ingest") {
      const sourcePaths = positional.map((item) => path.resolve(item));
      if (!sourcePaths.length) throw new Error("Usage: afh archive ingest <archive> <source...> --idempotency-key KEY [--origin-domain-id ID]");
      const harness = String(flags.harness || "generic");
      const origin = String(flags["origin-domain-id"] || inferOriginDomain(archive, harness));
      params = { idempotency_key: required(flags["idempotency-key"], "afh archive ingest <archive> <source...> --idempotency-key KEY"), sources: sourcePaths.map(sourcePath => ({ path: sourcePath, harness, origin_domain_id: origin })), include_children: boolFlag(flags.children, true) };
      const maxChildren = numberFlag(flags["max-child-sessions"], "max-child-sessions"); if (maxChildren != null) params.max_child_sessions = maxChildren;
    } else if (action === "verify") params = { deep: boolFlag(flags.deep, true) };
    else if (action === "recover") params = { idempotency_key: required(flags["idempotency-key"], "afh archive recover <archive> --idempotency-key KEY --job-id ID --owner-token TOKEN --action resume|abandon"), job_id: required(flags["job-id"], "afh archive recover ... --job-id ID"), expected_owner_token: required(flags["owner-token"], "afh archive recover ... --owner-token TOKEN"), action: required(flags.action, "afh archive recover ... --action resume|abandon") };
    else if (action === "show") params = { event_id: required(positional.shift(), "afh archive show <archive> <event-id>"), include_representations: boolFlag(flags.representations, true) };
    else if (action === "evidence") {
      params = { uri: required(positional.shift(), "afh archive evidence <archive> <afh://evidence/...>") };
      if (flags.format) params.format = String(flags.format); const offset=numberFlag(flags.offset,"offset"),max=numberFlag(flags["max-bytes"],"max-bytes"); if(offset!=null)params.offset=offset;if(max!=null)params.max_bytes=max;if(flags["json-pointer"]!=null)params.json_pointer=String(flags["json-pointer"]);
    } else if (action === "stats") params = {
      scope:{project_id:null,session_ids:[],group_id:null,association_mode:"observed"},
      time:{known_at:null,valid_at:null,from:null,to:null,include_uncertain:true},
      metric:String(flags.metric || "executions"),
      group_by:flags["group-by"] ? String(flags["group-by"]).split(",").filter(Boolean) : [],
    };
  }
  const request = { kind:"request", schema_version:4, protocol_version:"4.0", request_id:String(flags["request-id"] || `cli-${randomUUID()}`), operation, archive, revision_id:flags.revision == null ? null : String(flags.revision), params };
  return { request, action };
}

export async function runArchiveCli(positional, flags) {
  const { request } = buildArchiveCliRequest(positional, flags);
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Archive request must be a JSON object");
  const response = await archiveRequest(request, { onProgress: flags["progress-json"] ? item => process.stderr.write(`${JSON.stringify(item)}\n`) : undefined });
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  if (response?.error || request.operation === "archive.verify" && response?.data?.passed !== true) process.exitCode = 1;
}

export const archiveCliMutates = operation => MUTATING.has(operation);
