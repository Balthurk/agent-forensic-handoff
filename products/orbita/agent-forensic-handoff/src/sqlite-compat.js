import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";

let NativeDatabaseSync = null;
try {
  if (typeof process.getBuiltinModule === "function") {
    const mod = process.getBuiltinModule("node:sqlite");
    if (mod && mod.DatabaseSync) NativeDatabaseSync = mod.DatabaseSync;
  }
} catch {}
if (!NativeDatabaseSync) {
  try {
    const mod = await import("node:sqlite");
    if (mod && mod.DatabaseSync) NativeDatabaseSync = mod.DatabaseSync;
  } catch {}
}

const PY_SCRIPT = String.raw`
import sys, json, sqlite3, base64, math, struct, re
# The Node pipe is UTF-8 even when the host's Python locale is not.
sys.stdin.reconfigure(encoding="utf-8", errors="strict")
sys.stdout.reconfigure(encoding="utf-8", errors="strict")

dbs = {}
next_id = 1

def unpack_f32(b):
    if b is None: return []
    if isinstance(b, memoryview): b = b.tobytes()
    if isinstance(b, str): b = b.encode("latin1")
    n = len(b) // 4
    return struct.unpack(f"<{n}f", b[:n*4])

def cosine_dist(a, b):
    va = unpack_f32(a)
    vb = unpack_f32(b)
    if not va or not vb or len(va) != len(vb): return 1.0
    dot = sum(x*y for x, y in zip(va, vb))
    na = math.sqrt(sum(x*x for x in va))
    nb = math.sqrt(sum(y*y for y in vb))
    if na == 0 or nb == 0: return 1.0
    return max(0.0, 1.0 - (dot / (na * nb)))

def encode_val(v):
    if isinstance(v, (bytes, bytearray, memoryview)):
        b = bytes(v)
        return {"__bytes__": base64.b64encode(b).decode("ascii")}
    return v

def decode_val(v):
    if isinstance(v, dict) and "__bytes__" in v:
        return base64.b64decode(v["__bytes__"])
    return v

def rewrite_sql(sql):
    sql = re.sub(
        r"CREATE\s+VIRTUAL\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?vector_index\s+USING\s+vec0\([^)]+\)",
        "CREATE TABLE IF NOT EXISTS vector_index (rowid INTEGER PRIMARY KEY, embedding BLOB)",
        sql,
        flags=re.IGNORECASE,
    )
    if "vector_index" in sql and "MATCH" in sql:
        q_tok = "$query" if "$query" in sql else "?"
        sql = re.sub(
            r"SELECT\s+rowid\s*,\s*distance\s+FROM\s+vector_index\s+WHERE\s+embedding\s+MATCH\s+(?:\$query|\?)",
            f"SELECT rowid, vec_distance_cosine(embedding, {q_tok}) AS distance FROM vector_index",
            sql,
            flags=re.IGNORECASE,
        )
    return sql

for line in sys.stdin:
    line = line.strip()
    if not line: continue
    req = json.loads(line)
    op = req.get("op")
    try:
        if op == "open":
            path = req["path"]
            ro = req.get("readOnly", False)
            if ro and path != ":memory:":
                uri = "file:" + path + "?mode=ro"
                conn = sqlite3.connect(uri, uri=True, isolation_level=None, check_same_thread=False)
            else:
                conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.create_function("vec_distance_cosine", 2, cosine_dist)
            conn.create_function("vec_version", 0, lambda: "v0.1.6-compat")
            db_id = next_id
            next_id += 1
            dbs[db_id] = conn
            res = {"ok": True, "dbId": db_id}
        elif op == "close":
            conn = dbs.pop(req["dbId"], None)
            if conn: conn.close()
            res = {"ok": True}
        elif op == "exec":
            conn = dbs[req["dbId"]]
            sql = rewrite_sql(req["sql"])
            # SQLite recognizes literals, comments and the full trigger body.
            # executescript() would implicitly commit an existing transaction.
            start = 0
            for pos, char in enumerate(sql):
                if char == ";" and sqlite3.complete_statement(sql[start:pos + 1]):
                    cur = conn.execute(sql[start:pos + 1])
                    try:
                        for _ in cur: pass
                    finally:
                        cur.close()
                    start = pos + 1
            if sql[start:].strip():
                cur = conn.execute(sql[start:])
                try:
                    for _ in cur: pass
                finally:
                    cur.close()
            res = {"ok": True}
        elif op in ("run", "get", "all"):
            conn = dbs[req["dbId"]]
            sql = rewrite_sql(req["sql"])
            params = req.get("params", [])
            if isinstance(params, dict):
                params = {k: decode_val(v) for k, v in params.items()}
                needed = set(re.findall(r"[:$@]([a-zA-Z0-9_]+)", sql))
                for k in needed:
                    if k not in params: params[k] = None
            else:
                params = [decode_val(x) for x in params]
            cur = conn.execute(sql, params)
            try:
                if op == "run":
                    for _ in cur: pass
                elif op == "get":
                    row = cur.fetchone()
                    res = {"ok": True, "row": {k: encode_val(row[k]) for k in row.keys()} if row else None}
                else:
                    rows = cur.fetchall()
                    res = {"ok": True, "rows": [{k: encode_val(r[k]) for k in r.keys()} for r in rows]}
            finally:
                cur.close()
            if op == "run":
                # changes() excludes trigger side effects and reflects this
                # statement, including zero-row CAS and RETURNING completion.
                counters = conn.execute("SELECT changes(), last_insert_rowid()")
                try:
                    changes, last_id = counters.fetchone()
                finally:
                    counters.close()
                res = {"ok": True, "changes": changes, "lastInsertRowid": last_id}
        else:
            res = {"ok": False, "error": f"Unknown op {op}"}
    except Exception as e:
        res = {"ok": False, "error": str(e), "code": getattr(e, "sqlite_errorname", "SQLITE_ERROR")}
    sys.stdout.write(json.dumps(res) + "\n")
    sys.stdout.flush()
`;

const WORKER_CODE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

const py = spawn(workerData.python, ["-u", "-c", workerData.pyScript], {
  stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});
const decoder = new StringDecoder("utf8");
let pieces = [];
let stderr = "";
let pending = null;
let terminal = null;

function reply(line) {
  if (!pending) return;
  const { port, sab } = pending;
  pending = null;
  try { port.postMessage(line); } finally {
    port.close();
    const i32 = new Int32Array(sab);
    Atomics.store(i32, 0, 1);
    Atomics.notify(i32, 0, 1);
  }
}
function fail(code, message) {
  if (!terminal) terminal = { ok: false, fatal: true, code, error: message };
  reply(JSON.stringify(terminal));
}
function stop() {
  py.stdin.destroy();
  if (py.exitCode === null && py.signalCode === null) {
    py.kill();
    const escalation = setTimeout(() => {
      if (py.exitCode === null && py.signalCode === null) py.kill("SIGKILL");
    }, 1000);
    escalation.unref();
    py.once("close", () => clearTimeout(escalation));
  }
  parentPort.close();
}
py.on("error", error => fail("SQLITE_BACKEND_START_FAILED", "SQLite Python could not start: " + error.message));
py.on("exit", (code, signal) => fail("SQLITE_BACKEND_EXIT", "SQLite Python exited (" + (signal || code) + "). The last operation may have committed; no request was replayed."));
py.stdin.on("error", error => fail("SQLITE_BACKEND_PIPE", "SQLite Python input failed: " + error.message));
py.stdout.on("error", error => fail("SQLITE_BACKEND_PIPE", "SQLite Python output failed: " + error.message));
// Always drain stderr. It cannot block the response pipe; diagnostics stay bounded.
py.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-4096); });
py.stderr.on("error", () => {});
py.stdout.on("data", chunk => {
  const text = decoder.write(chunk);
  let start = 0;
  let idx = text.indexOf("\n");
  while (idx !== -1) {
    pieces.push(text.slice(start, idx));
    const line = pieces.join("");
    pieces = [];
    if (!pending) { fail("SQLITE_BACKEND_PROTOCOL", "Unexpected SQLite response"); stop(); return; }
    reply(line);
    start = idx + 1;
    idx = text.indexOf("\n", start);
  }
  if (start < text.length) pieces.push(text.slice(start));
});
parentPort.on("message", msg => {
  if (msg.cancel) { stop(); return; }
  pending = msg;
  if (terminal) { reply(JSON.stringify(terminal)); return; }
  try { py.stdin.write(msg.req + "\n"); }
  catch (error) { fail("SQLITE_BACKEND_PIPE", "SQLite Python input failed: " + error.message); }
});
`;

let currentSession = null;

function sqliteError(code, message) {
  return Object.assign(new Error(message), { code });
}

function requestTimeout() {
  const raw = process.env.AFH_SQLITE_TIMEOUT_MS;
  const timeout = raw === undefined ? 30000 : Number(raw);
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 300000) {
    throw sqliteError("SQLITE_BACKEND_CONFIGURATION", "AFH_SQLITE_TIMEOUT_MS must be an integer from 100 to 300000 milliseconds");
  }
  return timeout;
}

function invalidate(session) {
  if (session.failed) return;
  session.failed = true;
  if (currentSession === session) currentSession = null;
  // The worker owns the child handle. Cancel only that child, never a reused PID.
  try { session.worker.postMessage({ cancel: true }); } catch {}
}

function ensureSession() {
  if (currentSession && !currentSession.failed) return currentSession;
  requestTimeout();
  const python = process.env.AFH_SQLITE_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  if (!python.trim()) throw sqliteError("SQLITE_BACKEND_CONFIGURATION", "AFH_SQLITE_PYTHON must name an executable");
  const session = { failed: false, worker: new Worker(WORKER_CODE, { eval: true, workerData: { pyScript: PY_SCRIPT, python } }) };
  session.worker.on("error", () => invalidate(session));
  session.worker.on("exit", () => invalidate(session));
  session.worker.unref();
  currentSession = session;
  return session;
}

function callPy(session, payload) {
  if (session.failed) throw sqliteError("SQLITE_BACKEND_LOST", "SQLite backend is unavailable; this handle cannot be reused. No request was replayed.");
  const timeout = requestTimeout();
  const req = JSON.stringify(payload);
  const sab = new SharedArrayBuffer(4);
  const i32 = new Int32Array(sab);
  const { port1, port2 } = new MessageChannel();
  let res;
  try {
    session.worker.postMessage({ req, port: port2, sab }, [port2]);
    if (Atomics.wait(i32, 0, 0, timeout) === "timed-out") {
      throw sqliteError("SQLITE_BACKEND_TIMEOUT", "SQLite Python did not respond within " + timeout + "ms. The operation may have committed; no request was replayed. All handles for this backend are invalid.");
    }
    const msg = receiveMessageOnPort(port1);
    if (!msg || typeof msg.message !== "string") throw new Error("Missing SQLite response");
    res = JSON.parse(msg.message);
    if (!res || typeof res.ok !== "boolean") throw new Error("Invalid SQLite response");
  } catch (error) {
    invalidate(session);
    throw error.code ? error : sqliteError("SQLITE_BACKEND_PROTOCOL", error.message + "; no request was replayed");
  } finally {
    port1.close();
    port2.close();
  }
  if (!res.ok) {
    if (res.fatal) invalidate(session);
    throw sqliteError(res.code || "SQLITE_ERROR", res.error || "SQLite error");
  }
  return res;
}

function encodeParam(val) {
  if (val === undefined) return null;
  if (typeof val === "bigint") return Number(val);
  if (Buffer.isBuffer(val) || val instanceof Uint8Array || ArrayBuffer.isView(val)) {
    const buf = Buffer.isBuffer(val) ? val : Buffer.from(val.buffer, val.byteOffset, val.byteLength);
    return { __bytes__: buf.toString("base64") };
  }
  return val;
}

function normalizeParams(args) {
  if (args.length === 0) return [];
  if (
    args.length === 1 &&
    args[0] &&
    typeof args[0] === "object" &&
    !Array.isArray(args[0]) &&
    !Buffer.isBuffer(args[0]) &&
    !ArrayBuffer.isView(args[0])
  ) {
    const out = {};
    for (const [k, v] of Object.entries(args[0])) {
      out[k.replace(/^[$:@]/, "")] = encodeParam(v);
    }
    return out;
  }
  return args.map(encodeParam);
}

function decodeRow(row) {
  if (!row) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === "object" && "__bytes__" in v) {
      out[k] = new Uint8Array(Buffer.from(v.__bytes__, "base64"));
    } else {
      out[k] = v;
    }
  }
  return out;
}

class FallbackStatementSync {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }
  call(op, args) {
    this.db.assertOpen();
    return callPy(this.db.session, { op, dbId: this.db.dbId, sql: this.sql, params: normalizeParams(args) });
  }
  run(...args) {
    const res = this.call("run", args);
    return { changes: res.changes, lastInsertRowid: res.lastInsertRowid };
  }
  get(...args) {
    return decodeRow(this.call("get", args).row);
  }
  all(...args) {
    return (this.call("all", args).rows || []).map(decodeRow);
  }
}

class FallbackDatabaseSync {
  constructor(filePath, options = {}) {
    this.session = ensureSession();
    const res = callPy(this.session, { op: "open", path: String(filePath), readOnly: Boolean(options.readOnly) });
    this.dbId = res.dbId;
    this.open = true;
  }
  assertOpen() {
    if (!this.open) throw sqliteError("SQLITE_DATABASE_CLOSED", "SQLite database is closed");
    if (this.session.failed) throw sqliteError("SQLITE_BACKEND_LOST", "SQLite backend is unavailable; this handle cannot be reused. No request was replayed.");
  }
  exec(sql) {
    this.assertOpen();
    callPy(this.session, { op: "exec", dbId: this.dbId, sql: String(sql) });
  }
  prepare(sql) {
    this.assertOpen();
    return new FallbackStatementSync(this, String(sql));
  }
  enableLoadExtension() {}
  loadExtension() {}
  close() {
    if (!this.open) return;
    this.open = false;
    if (!this.session.failed) callPy(this.session, { op: "close", dbId: this.dbId });
  }
}

export const DatabaseSync = NativeDatabaseSync || FallbackDatabaseSync;

export async function loadVectorExtension() {
  if (NativeDatabaseSync) {
    try {
      const mod = await import("sqlite-vec");
      if (mod && typeof mod.load === "function") return mod;
      if (mod?.default && typeof mod.default.load === "function") return mod.default;
    } catch (err) {
      throw err;
    }
  }
  return {
    load() {},
  };
}
