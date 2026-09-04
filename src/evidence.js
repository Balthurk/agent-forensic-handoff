import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { ensureDir, sha256 } from "./util.js";

export function compressionFor(filePath) {
  if (filePath.endsWith(".zst") || filePath.endsWith(".zstd")) return "zstd";
  if (filePath.endsWith(".gz")) return "gzip";
  return "none";
}

export function openDecodedStream(filePath, byteLimit = null) {
  const compression = compressionFor(filePath);
  if (byteLimit === 0) return { stream: Readable.from([]), compression };
  const streamOptions = byteLimit == null ? {} : { start: 0, end: Math.max(0, byteLimit - 1) };
  const source = fs.createReadStream(filePath, streamOptions);
  if (compression === "none") return { stream: source, compression };
  if (compression === "gzip") return { stream: source.pipe(zlib.createGunzip()), compression };
  if (typeof zlib.createZstdDecompress === "function") {
    return { stream: source.pipe(zlib.createZstdDecompress()), compression };
  }
  const child = spawn("zstd", ["-dc"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  source.pipe(child.stdin);
  source.on("error", (error) => child.stdin.destroy(error));
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", (code) => {
    if (code !== 0) child.stdout.destroy(new Error(`zstd exited ${code}: ${stderr.slice(0, 500)}`));
  });
  return { stream: child.stdout, compression };
}

export async function* decodedLines(filePath, byteLimit = null) {
  const { stream, compression } = openDecodedStream(filePath, byteLimit);
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let ordinal = 0;
  let offset = 0;
  for await (const line of lines) {
    const bytes = Buffer.byteLength(line, "utf8");
    yield { line, ordinal, byteOffset: offset, byteLength: bytes, compression };
    offset += bytes + 1;
    ordinal += 1;
  }
}

export class EvidenceStore {
  constructor(caseDir, { db = null, inlineBlobBytes = 16 * 1024 } = {}) {
    this.caseDir = caseDir;
    this.db = db;
    this.inlineBlobBytes = inlineBlobBytes;
    this.root = ensureDir(path.join(caseDir, "evidence"));
    this.blobRoot = ensureDir(path.join(this.root, "blobs"));
    this.sourceRoot = ensureDir(path.join(this.root, "sources"));
  }

  putText(text, extension = "txt") {
    const buffer = Buffer.from(String(text), "utf8");
    return this.putBuffer(buffer, extension);
  }

  digestText(text) {
    const buffer = Buffer.from(String(text), "utf8");
    return { sha256: sha256(buffer), byteLength: buffer.length, path: null, storage: "SOURCE" };
  }

  putJson(value) {
    return this.putText(JSON.stringify(value), "json");
  }

  putBuffer(buffer, extension = "bin") {
    const hash = sha256(buffer);
    const safeExtension = /^[a-z0-9]{1,12}$/i.test(extension) ? extension.toLowerCase() : "bin";
    if (this.db && buffer.length <= this.inlineBlobBytes) {
      this.db.insertContentBlob({
        sha256: hash, byteLength: buffer.length, extension: safeExtension,
        storage: "SQLITE", inlineData: buffer,
      });
      return { sha256: hash, byteLength: buffer.length, path: null, storage: "SQLITE" };
    }
    const dir = ensureDir(path.join(this.blobRoot, hash.slice(0, 2)));
    const filePath = path.join(dir, `${hash}.${safeExtension}`);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer, { mode: 0o600 });
    const relativePath = path.relative(this.caseDir, filePath).replaceAll(path.sep, "/");
    this.db?.insertContentBlob({
      sha256: hash, byteLength: buffer.length, extension: safeExtension,
      storage: "FILE", path: relativePath,
    });
    return { sha256: hash, byteLength: buffer.length, path: relativePath, storage: "FILE" };
  }

  beginCanonicalSource(sourceId, locatorHash) {
    const tempPath = path.join(this.sourceRoot, `.${sourceId}.${process.pid}.jsonl.tmp`);
    const fd = fs.openSync(tempPath, "wx", 0o600);
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    return {
      append(line) {
        const buffer = Buffer.from(`${line}\n`, "utf8");
        fs.writeSync(fd, buffer);
        hash.update(buffer);
        bytes += buffer.length;
      },
      finish: () => {
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        const digest = hash.digest("hex");
        const target = path.join(this.sourceRoot, `${locatorHash || digest}.jsonl`);
        if (fs.existsSync(target)) fs.unlinkSync(tempPath);
        else fs.renameSync(tempPath, target);
        return {
          sha256: digest,
          byteLength: bytes,
          path: path.relative(this.caseDir, target).replaceAll(path.sep, "/"),
        };
      },
      abort() {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(tempPath); } catch {}
      },
    };
  }
}

export function resolveEvidenceRange(caseDir, ref) {
  const match = /^afh:\/\/evidence\/sha256\/([a-f0-9]{64})\/record\/(\d+)(?:#bytes=(\d+):(\d+))?$/.exec(ref);
  if (!match) throw new Error("Invalid AFH evidence URI");
  const [, sourceHash, ordinal, offsetRaw, lengthRaw] = match;
  const sourcePath = path.resolve(caseDir, "evidence", "sources", `${sourceHash}.jsonl`);
  const evidenceRoot = path.resolve(caseDir, "evidence") + path.sep;
  if (!sourcePath.startsWith(evidenceRoot) || !fs.existsSync(sourcePath)) throw new Error("Evidence source is unavailable");
  const offset = Number(offsetRaw);
  const length = Number(lengthRaw);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > 64 * 1024 * 1024) {
    throw new Error("Evidence byte range is invalid or exceeds the safe preview limit");
  }
  const fd = fs.openSync(sourcePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, offset);
    return { sourceHash, ordinal: Number(ordinal), text: buffer.subarray(0, read).toString("utf8") };
  } finally { fs.closeSync(fd); }
}
