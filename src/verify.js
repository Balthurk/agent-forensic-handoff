import fs from "node:fs";
import path from "node:path";
import { EPISTEMIC } from "./constants.js";
import { hashFile, runReadOnly, shortHash, stableStringify } from "./util.js";

function chooseWorkspace(db, explicitWorkspace) {
  if (explicitWorkspace) {
    const candidate = path.resolve(explicitWorkspace);
    try { return fs.statSync(candidate).isDirectory() ? candidate : null; }
    catch { return null; }
  }
  const rows = db.all("SELECT cwd, COUNT(*) n FROM session WHERE cwd IS NOT NULL GROUP BY cwd ORDER BY n DESC, cwd LIMIT 5");
  return rows.map((row) => row.cwd).find((cwd) => {
    try { return fs.statSync(cwd).isDirectory(); } catch { return false; }
  }) ?? null;
}

export async function verifyCurrentState(db, options = {}) {
  const level = String(options.level || "V0").toUpperCase();
  if (!["V0", "V1"].includes(level)) throw new Error("This release supports V0 and V1 only; V2/V3 require an explicit project verifier");
  const workspace = chooseWorkspace(db, options.workspace);
  const observedAt = new Date().toISOString();
  const metadata = { level, workspaceExists: Boolean(workspace), filesInspected: 0, symlinksSkipped: 0 };
  let gitHead = null;
  let gitBranch = null;
  let gitStatus = null;

  if (workspace) {
    const head = runReadOnly("git", ["rev-parse", "HEAD"], workspace);
    const branch = runReadOnly("git", ["branch", "--show-current"], workspace);
    const status = runReadOnly("git", ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"], workspace);
    if (head.status === 0) gitHead = head.stdout.trim();
    if (branch.status === 0) gitBranch = branch.stdout.trim();
    if (status.status === 0) gitStatus = status.stdout.trim();
    metadata.gitErrors = [head, branch, status].filter((item) => item.status !== 0).map((item) => ({ command: item.command, status: item.status, stderr: item.stderr.slice(0, 300) }));
  }

  const snapshotPayload = { workspace, level, gitHead, gitBranch, gitStatus };
  const snapshotSha = shortHash(stableStringify(snapshotPayload), 64);
  db.insertSnapshot({
    id: `snp-${shortHash(snapshotPayload)}`, root: workspace, observedAt, head: gitHead,
    branch: gitBranch, status: gitStatus, metadata: stableStringify(metadata), sha: snapshotSha,
  });

  if (!workspace) {
    db.insertValidation({
      id: `val-${shortHash(["workspace", observedAt])}`, target: "workspace", level,
      method: "filesystem existence", command: null, result: "UNAVAILABLE: no current workspace path exists",
      observedAt, freshness: snapshotSha, status: EPISTEMIC.UNAVAILABLE, event: null,
    });
    return { workspace, level, snapshotSha, gitHead, gitBranch, gitStatus, metadata };
  }

  const artifacts = db.all("SELECT * FROM artifact ORDER BY logical_path");
  for (const artifact of artifacts) {
    const candidate = resolveArtifactPath(artifact, workspace);
    let state = "MISSING";
    let currentSha = null;
    let status = EPISTEMIC.CORROBORATED;
    let observedResult = "missing from current workspace";
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        metadata.symlinksSkipped += 1;
        state = "LIVE_UNVERIFIED";
        status = EPISTEMIC.UNCERTAIN;
        observedResult = "symlink exists; target not followed";
      } else if (stat.isFile()) {
        currentSha = await hashFile(candidate);
        metadata.filesInspected += 1;
        const latest = db.get("SELECT content_sha256 FROM artifact_revision WHERE artifact_id=$id ORDER BY observed_at DESC,id DESC LIMIT 1", { id: artifact.id });
        if (latest?.content_sha256 && latest.content_sha256 === currentSha) {
          state = "LIVE_VERIFIED";
          observedResult = "current file hash equals latest directly captured full-content revision";
        } else {
          state = "LIVE_UNVERIFIED";
          observedResult = latest?.content_sha256 ? "current file exists but differs from latest captured full-content revision" : "current file exists; no full-content revision hash is available";
        }
      } else {
        state = "LIVE_UNVERIFIED";
        observedResult = "path exists but is not a regular file";
      }
    } catch {}
    db.run("UPDATE artifact SET current_path=$path,current_status=$status,current_sha256=$sha WHERE id=$id", {
      id: artifact.id, path: candidate, status: state, sha: currentSha,
    });
    db.insertValidation({
      id: `val-${shortHash([artifact.id, snapshotSha])}`, target: artifact.logical_path, level,
      method: "filesystem hash", command: null, result: observedResult, observedAt,
      freshness: snapshotSha, status, event: null,
    });
  }

  if (level === "V1") {
    const configCandidates = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "Makefile"];
    const present = configCandidates.filter((name) => fs.existsSync(path.join(workspace, name)));
    db.insertValidation({
      id: `val-${shortHash(["project-config", snapshotSha])}`, target: "project configuration", level,
      method: "configuration inspection", command: null,
      result: present.length ? `Observed: ${present.join(", ")}; no project command executed` : "No common project configuration observed; no project command executed",
      observedAt, freshness: snapshotSha, status: EPISTEMIC.DIRECT, event: null,
    });
  }
  return { workspace, level, snapshotSha, gitHead, gitBranch, gitStatus, metadata };
}

function resolveArtifactPath(artifact, workspace) {
  const workspaceRoot = path.resolve(workspace);
  const target = path.isAbsolute(artifact.logical_path)
    ? path.resolve(artifact.logical_path)
    : path.resolve(workspaceRoot, artifact.logical_path);
  const root = workspaceRoot + path.sep;
  if (target !== workspaceRoot && !target.startsWith(root)) throw new Error(`Artifact path escapes workspace: ${artifact.logical_path}`);
  return target;
}
