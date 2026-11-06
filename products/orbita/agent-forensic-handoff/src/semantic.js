import {collectFullTextChunks,verifyFullTextChunks} from './fulltext-chunks.js';
import native from "node:fs";
import fs from './common-files.js';
import path from "node:path";
import { DatabaseSync } from './common-store.js';
import { AFH_VERSION } from "./constants.js";
import { CaseDatabase } from "./database.js";
import { verifyCaseIntegrity } from "./integrity.js";
import { loadManifest } from "./render.js";
import {
  createTransformersProvider, digestDirectory, SemanticUnavailableError,
  validateProviderIdentity, validateProviderVectors,
} from "./semantic-model.js";
import { preview, sha256, stableStringify } from "./util.js";
import {ensureDir} from './common-util.js';

const PROJECTION_SCHEMA_VERSION = 2;
const NORMALIZATION_VERSION = "event-preview-normalization-v1";
const CHUNKING_VERSION = "event-preview-chunking-v1";
const REDACTION_VERSION = "afh-redaction-v1";
const DEFAULT_CHUNK_CHARS = 1_600;
const DEFAULT_CHUNK_OVERLAP = 200;
const HARD_MAX_RESULTS = 1_000;

export async function buildSemanticIndex(caseDir, options = {}) {
  if(options.representation && !['event_previews','full_source_text'].includes(options.representation))throw new Error('Invalid semantic representation');
  const root = path.resolve(caseDir);
  const core = await verifyCaseIntegrity(root, { deep: options.verifyCoreDeep === true, verifyProjections: false });
  if (!core.passed) throw new Error(`Cannot build semantic projection because the forensic case failed integrity: ${failedChecks(core)}`);
  const caseManifest = loadManifest(root);
  const ownsProvider = !options.provider;
  const provider = options.provider || await createTransformersProvider({
    model: options.model, revision: options.revision, dimensions: options.dimensions,
    dtype: options.dtype, modelHome: options.modelHome, allowDownload: options.allowModelDownload === true,
  });
  const identity = validateProviderIdentity(provider.identity);
  const chunkChars = boundedInteger(options.chunkChars ?? DEFAULT_CHUNK_CHARS, "chunkChars", 256, 16_384);
  const chunkOverlap = boundedInteger(options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP, "chunkOverlap", 0, chunkChars - 1);
  const batchSize = boundedInteger(options.batchSize ?? 16, "batchSize", 1, 64);
  const maxBatchChars = boundedInteger(options.maxBatchChars ?? 16_000, "maxBatchChars", 1_600, 131_072);
  const fullText = options.representation === "full_source_text";
  const maxTokens = fullText ? Math.min(384, provider.maxInputTokens ?? 384) : null;
  if(fullText && typeof provider.countTokens !== "function") throw new Error("FULLTEXT_TOKEN_COUNTER_REQUIRED");
  const projectionConfig = {
    ...(fullText ? {representation:"full_source_text",tokenLimit:maxTokens,rangeUnit:"unicode_codepoints"} : {}),
    caseHash: caseManifest.caseHash,
    sourceSnapshotHash: caseManifest.sourceSnapshotHash,
    provider: identity,
    normalizationVersion: fullText ? "literal-fulltext-v1" : NORMALIZATION_VERSION,
    chunkingVersion: fullText ? "token-bounded-codepoint-v1" : CHUNKING_VERSION,
    redactionVersion: REDACTION_VERSION,
    chunkChars,
    chunkOverlap,
    embeddingBatchSize: batchSize,
    maxBatchChars,
    vectorEngine: {name:'postgresql-common-exact',version:'1',numericContract:'sqlite-vec-0.1.9-cosine-f32',ties:'chunk1024-asc-slot-desc'},
  };
  const projectionId = `sem-${sha256(stableStringify(projectionConfig)).slice(0, 24)}`;
  const projectionsRoot = path.resolve(options.out || path.join(root, "projections"));
  const projectionDir = path.join(projectionsRoot, projectionId);
  ensureDir(projectionsRoot);

  try {
    if (fs.existsSync(path.join(projectionDir, "projection.json")) && !options.rebuild) {
      const verification = await verifySemanticProjection(root, projectionDir, { deep: true });
      if (!verification.passed) throw new Error(`Existing semantic projection is unhealthy; use --rebuild: ${failedChecks(verification)}`);
      return { ...projectionResult(projectionDir, verification.manifest), reused: true };
    }
    const staging = path.join(projectionsRoot, `.${projectionId}.tmp-${process.pid}`);
    assertDirectChild(staging, projectionsRoot);
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    ensureDir(staging);
    let db;
    try {
      const full = fullText ? collectFullTextChunks(root,{chunkChars,chunkOverlap,maxTokens,countTokens:provider.countTokens}) : null;
      const chunks = full?.chunks ?? collectSemanticChunks(root, { chunkChars, chunkOverlap });
      const unique = new Map();
      for (const chunk of chunks) if (!unique.has(chunk.contentHash)) unique.set(chunk.contentHash, chunk.text);
      options.onProgress?.({ phase: "prepared", chunks: chunks.length, uniqueEmbeddings: unique.size });
      const createdAt = new Date().toISOString();
      const dbPath = path.join(staging, "semantic.pgstore");
      db = new DatabaseSync(dbPath, {family:'vector',create:true});
      createProjectionSchema(db, Number(identity.dimensions));
      db.exec("BEGIN IMMEDIATE");
      db.prepare(`INSERT INTO semantic_projection
        (id,case_hash,source_snapshot_hash,projection_schema_version,tool_version,provider_json,
         config_json,created_at,status,failure_reason,projection_hash)
        VALUES ($id,$caseHash,$sourceHash,$schema,$tool,$provider,$config,$created,'BUILDING',NULL,'')`).run({
        id: projectionId, caseHash: caseManifest.caseHash, sourceHash: caseManifest.sourceSnapshotHash,
        schema: PROJECTION_SCHEMA_VERSION, tool: AFH_VERSION, provider: stableStringify(identity),
        config: stableStringify(projectionConfig), created: createdAt,
      });
      db.exec('COMMIT');

      const rowByContent = new Map();
      const entries = [...unique.entries()];
      let nextRowId = 1;
      const batches = boundedBatches(entries, batchSize, maxBatchChars);
      let completedEmbeddings = 0;
      for (const batch of batches) {
        const vectors = validateProviderVectors(await provider.embed(batch.map(([, text]) => text)), Number(identity.dimensions), batch.length);
        // Inference runs outside database transactions. Each completed batch
        // remains private to BUILDING staging until final verified publication.
        db.exec('BEGIN IMMEDIATE');
        for (let index = 0; index < batch.length; index += 1) {
          const [contentHash] = batch[index];
          const vector = vectorToBuffer(vectors[index]);
          const exact=bufferToVector(vector);
          if(!exact.every(Number.isFinite)||!exact.some(x=>x!==0))throw new Error('Semantic float32 vector must be finite with defined cosine');
          const vectorHash = sha256(vector);
          const rowId = nextRowId++;
          db.prepare(`INSERT INTO semantic_embedding
            (rowid,content_hash,vector,vector_sha256,dimensions,created_at)
            VALUES ($rowid,$content,$vector,$vectorHash,$dimensions,$created)`).run({
            rowid: BigInt(rowId), content: contentHash, vector, vectorHash,
            dimensions: BigInt(identity.dimensions), created: createdAt,
          });
          db.prepare("INSERT INTO vector_index(rowid,embedding) VALUES ($rowid,$vector)").run({ rowid: BigInt(rowId), vector });
          rowByContent.set(contentHash, rowId);
        }
        db.exec('COMMIT');
        completedEmbeddings += batch.length;
        options.onProgress?.({ phase: "embedding", completedEmbeddings, uniqueEmbeddings: entries.length });
      }

      db.exec('BEGIN IMMEDIATE');
      const insertChunk = db.prepare(`INSERT INTO semantic_chunk
        (id,content_hash,embedding_rowid,event_id,source_id,record_ordinal,evidence_uri,
         session_id,event_kind,event_status,actor_kind,observed_at,chunk_index,text,text_sha256,
         redaction_state,created_at,start_cp,end_cp,token_count,representation_id,source_text_sha256)
        VALUES ($id,$content,$embedding,$event,$source,$ordinal,$evidence,$session,$kind,
         $status,$actor,$observed,$chunkIndex,$text,$textHash,$redaction,$created,$start,$end,$tokens,$rep,$sourceText)`);
      for (const chunk of chunks) insertChunk.run({
        id: chunk.id, content: chunk.contentHash, embedding: BigInt(rowByContent.get(chunk.contentHash)),
        event: chunk.eventId, source: chunk.sourceId, ordinal: BigInt(chunk.recordOrdinal),
        evidence: chunk.evidenceUri, session: chunk.sessionId, kind: chunk.kind,
        status: chunk.status, actor: chunk.actorKind, observed: chunk.observedAt,
        chunkIndex: BigInt(chunk.chunkIndex), text: chunk.text, textHash: sha256(chunk.text),
        redaction: chunk.redactionState, created: createdAt,
        start:chunk.start??null,end:chunk.end??null,tokens:chunk.tokens??null,rep:chunk.representationId??null,sourceText:chunk.sourceTextHash??null,
      });
      db.exec("INSERT INTO semantic_fts(chunk_id,text) SELECT id,text FROM semantic_chunk");
      const projectionHash = computeProjectionHash(db);
      const metrics = {
        ...(full ? {fullText:full.coverage} : {}),
        eligibleEvents: new Set(chunks.map((chunk) => chunk.eventId)).size,
        chunks: chunks.length,
        uniqueEmbeddings: unique.size,
        deduplicatedOccurrences: chunks.length - unique.size,
      };
      db.prepare("UPDATE semantic_projection SET status='COMPLETE',projection_hash=$hash,metrics_json=$metrics WHERE id=$id")
        .run({ id: projectionId, hash: projectionHash, metrics: stableStringify(metrics) });
      db.exec("COMMIT");
      const rowManifest=db.logicalManifest();
      db.close();
      db = null;
      const projectionManifest = {
        schemaVersion: PROJECTION_SCHEMA_VERSION,
        status: "COMPLETE",
        projectionId,
        projectionHash,
        caseHash: caseManifest.caseHash,
        sourceSnapshotHash: caseManifest.sourceSnapshotHash,
        createdAt,
        toolVersion: AFH_VERSION,
        model: identity,
        config: projectionConfig,
        metrics,
        storage: {engine:'postgresql-common',path:'semantic.pgstore',manifest:rowManifest},
        safety: {
          remoteContentSent: false,
          sourceEvidenceModified: false,
          projectionRebuildable: true,
          semanticScoreIsTruthConfidence: false,
          chunksMayContainSensitiveDerivedContent: true,
        },
      };
      fs.writeFileSync(path.join(staging, "projection.json"), `${JSON.stringify(projectionManifest, null, 2)}\n`, { mode: 0o600 });
      const stagedVerification = await verifySemanticProjection(root, staging, { deep: true });
      if (!stagedVerification.passed) throw new Error(`Staged semantic projection failed integrity: ${failedChecks(stagedVerification)}`);
      const sourceRecheck=await verifyCaseIntegrity(root,{verifyProjections:false});
      if(!sourceRecheck.passed)throw new Error('SOURCE_CHANGED_DURING_SEMANTIC_BUILD');
      let rollbackDir = null;
      if (fs.existsSync(projectionDir)) {
        if (!options.rebuild) throw new Error(`Semantic projection already exists: ${projectionDir}`);
        rollbackDir = path.join(projectionsRoot, `.${projectionId}.backup-${Date.now()}`);
        assertDirectChild(rollbackDir, projectionsRoot);
        fs.renameSync(projectionDir, rollbackDir);
      }
      try { fs.renameSync(staging, projectionDir); }
      catch (error) {
        if (rollbackDir && fs.existsSync(rollbackDir) && !fs.existsSync(projectionDir)) fs.renameSync(rollbackDir, projectionDir);
        throw error;
      }
      return { ...projectionResult(projectionDir, projectionManifest), reused: false, rollbackDir };
    } catch (error) {
      try { db?.exec("ROLLBACK"); } catch {}
      try { db?.close(); } catch {}
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  } finally {
    if (ownsProvider) await provider.dispose?.();
  }
}

export async function semanticSearch(caseDir, terms, options = {}) {
  const root = path.resolve(caseDir);
  const limit = boundedInteger(options.limit ?? 25, "limit", 1, HARD_MAX_RESULTS);
  const minSimilarity = boundedSimilarity(options.minSimilarity ?? 0.15);
  const projectionDir = resolveProjectionDir(root, options.projectionDir);
  const projectionIntegrity = await verifySemanticProjection(root, projectionDir, { deep: false });
  if (!projectionIntegrity.passed) throw new Error(`Semantic projection failed integrity: ${failedChecks(projectionIntegrity)}`);
  const projection = JSON.parse(fs.readFileSync(path.join(projectionDir, "projection.json"), "utf8"));
  if (projection.status !== "COMPLETE") throw new SemanticUnavailableError(`Semantic projection is not complete: ${projectionDir}`);
  const ownsProvider = !options.provider;
  const provider = options.provider || await createTransformersProvider({
    model: projection.model.modelId, revision: projection.model.revision,
    dimensions: projection.model.dimensions, dtype: projection.model.dtype,
    pooling: projection.model.pooling, normalization: projection.model.normalization,
    license: projection.model.license, modelHome: options.modelHome,
    allowDownload: false,
  });
  try {
    assertSameProvider(projection.model, validateProviderIdentity(provider.identity));
    const [vector] = validateProviderVectors(await provider.embed([String(terms)]), Number(projection.model.dimensions), 1);
    const queryVector = vectorToBuffer(vector);
    const db = new DatabaseSync(path.join(projectionDir, projection.storage.path), {family:'vector',readOnly:true});
    // Retain the qualified exact-search candidate bound and tie ordering.
    const candidateLimit = Math.min(4_096, Math.max(limit * 20, 100));
    const bestByEvent = new Map();
    try {
    db.exec('BEGIN');
    if(db.logicalManifest().sha256!==projection.storage.manifest.sha256)throw new Error('Semantic projection changed during query preparation');
    const nearest = db.nearestVectors(queryVector,candidateLimit);
    let rank = 0;
    for (const item of nearest) {
      rank += 1;
      if (1 - Number(item.distance) < minSimilarity) continue;
      const chunks = db.prepare("SELECT * FROM semantic_chunk WHERE embedding_rowid=$rowid ORDER BY event_id,chunk_index").all({ rowid: BigInt(item.rowid) });
      for (const chunk of chunks) {
        if (!passesChunkFilters(chunk, options.filters || options)) continue;
        const prior = bestByEvent.get(chunk.event_id);
        if (!prior || Number(item.distance) < prior.distance) bestByEvent.set(chunk.event_id, { chunk, distance: Number(item.distance), rank });
      }
    }
    } finally {db.close();}
    const caseDb = new CaseDatabase(path.join(root, "case.pgstore"), { readOnly: true });
    try {
      const results = [...bestByEvent.values()]
        .sort((a, b) => a.distance - b.distance || a.chunk.event_id.localeCompare(b.chunk.event_id))
        .slice(0, limit)
        .map(({ chunk, distance, rank: vectorRank }) => {
          const event = caseDb.get("SELECT e.*,a.kind actor_kind,a.role actor_role FROM event e LEFT JOIN actor a ON a.id=e.actor_id WHERE e.id=$id", { id: chunk.event_id });
          const evidence = caseDb.all("SELECT id,uri,json_pointer,availability FROM evidence_ref WHERE event_id=$id ORDER BY id", { id: chunk.event_id });
          return {
            ...event,
            evidence,
            semanticChunkId: chunk.id,
            semanticText: chunk.text,
            semanticRange: chunk.start_cp == null ? null : {start:Number(chunk.start_cp),end:Number(chunk.end_cp),rangeUnit:"unicode_codepoints",representationId:chunk.representation_id},
            explanation: {
              vectorRank,
              cosineDistance: distance,
              cosineSimilarity: 1 - distance,
              contentHash: chunk.content_hash,
              projectionId: projection.projectionId,
              note: "Similarity is retrieval relevance, not truth confidence.",
            },
          };
        });
      return {
        modeRequested: "semantic",
        modeEffective: "semantic",
        projectionId: projection.projectionId,
        model: projection.model,
        coverage: projection.metrics,
        minSimilarity,
        results,
      };
    } finally { caseDb.close(); }
  } finally {
    if (ownsProvider) await provider.dispose?.();
  }
}

export async function verifySemanticProjection(caseDir, projectionDir, { deep = true } = {}) {
  const root = path.resolve(caseDir);
  const target = path.resolve(projectionDir);
  const findings = [];
  const add = (check, ok, detail) => findings.push({ check, ok: Boolean(ok), detail });
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(target, "projection.json"), "utf8")); }
  catch (error) { return { projectionDir: target, passed: false, deep, findings: [{ check: "semantic.manifest", ok: false, detail: error.message }] }; }
  const caseManifest = loadManifest(root);
  add("semantic.manifest.complete", manifest.status === "COMPLETE", `status=${manifest.status ?? "missing"}`);
  add("semantic.case_identity", manifest.caseHash === caseManifest.caseHash && manifest.sourceSnapshotHash === caseManifest.sourceSnapshotHash,
    `projection=${manifest.caseHash}/${manifest.sourceSnapshotHash}; case=${caseManifest.caseHash}/${caseManifest.sourceSnapshotHash}`);
  const dbPath = path.resolve(target, manifest.storage?.path || "");
  add("semantic.postgresql.path", manifest.storage?.engine==='postgresql-common'&&manifest.storage?.path==='semantic.pgstore'&&dbPath.startsWith(`${target}${path.sep}`) && fs.existsSync(dbPath), manifest.storage?.path || "missing");
  if (!fs.existsSync(dbPath) || !dbPath.startsWith(`${target}${path.sep}`)) return { projectionDir: target, manifest, passed: false, deep, findings };
  let db;
  try {
    db = new DatabaseSync(dbPath, {family:'vector',readOnly:true});db.exec('BEGIN');
    const actualManifest=db.logicalManifest();
    const legacyHash=legacyProjectionHash(db,manifest);
    add('semantic.postgresql.rows_integrity',actualManifest.sha256===manifest.storage?.manifest?.sha256,
      `actual=${actualManifest.sha256}; expected=${manifest.storage?.manifest?.sha256??'missing'}`);
    const projection = db.prepare("SELECT * FROM semantic_projection WHERE id=$id").get({ id: manifest.projectionId });
    add("semantic.projection_row", Boolean(projection) && projection.status === "COMPLETE", projection ? `status=${projection.status}` : "missing");
    const embeddingCount = Number(db.prepare("SELECT COUNT(*) n FROM semantic_embedding").get().n);
    const chunkCount = Number(db.prepare("SELECT COUNT(*) n FROM semantic_chunk").get().n);
    let embeddings = [];
    let chunks = [];
    if (deep) {
      embeddings = db.prepare("SELECT rowid,* FROM semantic_embedding ORDER BY rowid").all();
      let vectorFailures = 0;
      for (const embedding of embeddings) {
        const data = Buffer.from(embedding.vector);
        if (data.length !== Number(embedding.dimensions) * 4 || Number(embedding.dimensions) !== Number(manifest.model.dimensions) || sha256(data) !== embedding.vector_sha256) { vectorFailures += 1; continue; }
        if (!bufferToVector(data).every(Number.isFinite)) vectorFailures += 1;
      }
      add("semantic.vectors", vectorFailures === 0, `${embeddings.length} vector(s); ${vectorFailures} invalid`);
      chunks = db.prepare("SELECT * FROM semantic_chunk ORDER BY id").all();
      let chunkFailures = 0;
      for (const chunk of chunks) if (sha256(chunk.text) !== chunk.text_sha256 || sha256(chunk.text) !== chunk.content_hash) chunkFailures += 1;
      if(manifest.config.representation==='full_source_text'){
        const check=verifyFullTextChunks(root,chunks.map(normalizeBigInts));
        add('semantic.fulltext_ranges',check.passed,JSON.stringify(check));
        add('semantic.fulltext_coverage',check.coveredCodepoints===manifest.metrics.fullText.sourceCodepoints && check.coveredCodepoints===manifest.metrics.fullText.coveredCodepoints && check.representations===manifest.metrics.fullText.representations,'Exact union of original codepoint ranges');
        add('semantic.token_bound',chunks.every(c=>Number(c.token_count)>0&&Number(c.token_count)<=manifest.config.tokenLimit),'Token counts bounded before embedding');
        const bad=Number(db.prepare('SELECT COUNT(*) n FROM semantic_chunk c LEFT JOIN semantic_fts f ON f.chunk_id=c.id WHERE f.chunk_id IS NULL OR f.text<>c.text').get().n);
        add('semantic.fulltext_fts',bad===0 && Number(db.prepare('SELECT COUNT(*) n FROM semantic_fts').get().n)===chunks.length,'Full literal text indexed in common lexical tables');
      }
      add("semantic.chunks", chunkFailures === 0, `${chunks.length} chunk(s); ${chunkFailures} hash mismatch(es)`);
    } else {
      add("semantic.vectors", embeddingCount === Number(manifest.metrics?.uniqueEmbeddings), `${embeddingCount} vector(s); bytes/finiteness covered by typed-row SHA-256; deep scan skipped`);
      add("semantic.chunks", chunkCount === Number(manifest.metrics?.chunks), `${chunkCount} chunk(s); typed-row SHA-256 passed; deep hash scan skipped`);
    }
    const orphanMappings = Number(db.prepare(`SELECT COUNT(*) n FROM semantic_chunk c LEFT JOIN semantic_embedding e ON e.rowid=c.embedding_rowid
      WHERE e.rowid IS NULL OR e.content_hash<>c.content_hash`).get().n);
    add("semantic.orphans", orphanMappings === 0, `${orphanMappings} orphan or mismatched chunk mapping(s)`);
    {
      const vectorIndexCount = Number(db.prepare("SELECT COUNT(*) n FROM vector_index").get().n);
      add("semantic.vector_index_count", vectorIndexCount === embeddingCount, `index=${vectorIndexCount}; embeddings=${embeddingCount}`);
      if (deep) {
        let indexFailures = 0;
        for (const indexed of db.prepare("SELECT rowid,embedding FROM vector_index ORDER BY rowid").all()) {
          const stored = embeddings.find((embedding) => Number(embedding.rowid) === Number(indexed.rowid));
          if (!stored || !Buffer.from(indexed.embedding).equals(Buffer.from(stored.vector))) indexFailures += 1;
        }
        add("semantic.vector_index_bytes", indexFailures === 0, `${indexFailures} index/vector mismatch(es)`);
      }
    }

    if (deep) {
      const caseDb = new CaseDatabase(path.join(root, "case.pgstore"), { readOnly: true });
      try {
        const eventIds = new Set(caseDb.all("SELECT id FROM event").map((row) => row.id));
        const evidence = new Map(caseDb.all("SELECT event_id,uri,availability FROM evidence_ref").map((row) => [`${row.event_id}\0${row.uri}`, row.availability]));
        let evidenceFailures = 0;
        for (const chunk of chunks) if (!eventIds.has(chunk.event_id) || evidence.get(`${chunk.event_id}\0${chunk.evidence_uri}`) !== "AVAILABLE") evidenceFailures += 1;
        add("semantic.evidence_links", evidenceFailures === 0, `${evidenceFailures} unresolved semantic chunk evidence link(s)`);
      } finally { caseDb.close(); }
      const projectionHash = computeProjectionHash(db,{legacyHash});
      add("semantic.projection_hash", projectionHash === manifest.projectionHash && projection?.projection_hash === manifest.projectionHash,
        `actual=${projectionHash}; expected=${manifest.projectionHash}`);
    } else {
      add("semantic.evidence_links", true, "case/source identity and full typed-row SHA-256 passed; deep link scan skipped");
      add("semantic.projection_hash", projection?.projection_hash === manifest.projectionHash, `row=${projection?.projection_hash}; expected=${manifest.projectionHash}; full recomputation skipped`);
    }
    add("semantic.metrics", Number(manifest.metrics?.chunks) === chunkCount && Number(manifest.metrics?.uniqueEmbeddings) === embeddingCount,
      `chunks=${chunkCount}/${manifest.metrics?.chunks}; embeddings=${embeddingCount}/${manifest.metrics?.uniqueEmbeddings}`);
  } catch (error) {
    add("semantic.verification_runtime", false, String(error.message || error));
  } finally { db?.close(); }

  if (manifest.model?.snapshotPath) {
    const available = native.existsSync(manifest.model.snapshotPath);
    let digest = null;
    try { if (available && deep) digest = digestDirectory(manifest.model.snapshotPath); } catch {}
    add("semantic.model_snapshot", available && (!deep || digest === manifest.model.modelDigest),
      available ? (deep ? `actual=${digest}; expected=${manifest.model.modelDigest}` : "snapshot present; digest scan skipped") : `unavailable=${manifest.model.snapshotPath}`);
  }
  return { projectionDir: target, manifest, deep, passed: findings.every((finding) => finding.ok), findings };
}

export function findSemanticProjection(caseDir, {representation} = {}) {
  const root = path.join(path.resolve(caseDir), "projections");
  if (!fs.existsSync(root)) return null;
  const candidates = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "projection.json")))
    .map((dir) => ({ dir, manifest: JSON.parse(fs.readFileSync(path.join(dir, "projection.json"), "utf8")) }))
    .filter((item) => item.manifest.status === "COMPLETE" && (!representation || item.manifest.config?.representation === representation))
    .sort((a, b) => String(b.manifest.createdAt).localeCompare(String(a.manifest.createdAt)) || b.dir.localeCompare(a.dir));
  return candidates[0]?.dir ?? null;
}

function collectSemanticChunks(caseDir, { chunkChars, chunkOverlap }) {
  const db = new CaseDatabase(path.join(caseDir, "case.pgstore"), { readOnly: true });
  try {
    const events = db.all(`SELECT e.*,a.kind actor_kind,
      (SELECT uri FROM evidence_ref er WHERE er.event_id=e.id AND er.availability='AVAILABLE' ORDER BY er.id LIMIT 1) evidence_uri
      FROM event e LEFT JOIN actor a ON a.id=e.actor_id
      WHERE e.canonical=1 AND (COALESCE(e.input_preview,'')<>'' OR COALESCE(e.output_preview,'')<>'')
      ORDER BY COALESCE(e.observed_at,''),e.source_id,e.record_ordinal,e.subordinal`);
    const chunks = [];
    for (const event of events) {
      if (!event.evidence_uri) continue;
      const searchable = normalizeSearchText([`${event.kind}${event.subtype ? `/${event.subtype}` : ""}`, event.input_preview, event.output_preview].filter(Boolean).join("\n"));
      if (!searchable) continue;
      const pieces = chunkText(searchable, chunkChars, chunkOverlap);
      for (let chunkIndex = 0; chunkIndex < pieces.length; chunkIndex += 1) {
        const text = pieces[chunkIndex];
        const contentHash = sha256(text);
        chunks.push({
          id: `chk-${sha256(stableStringify([event.id, chunkIndex, contentHash])).slice(0, 24)}`,
          eventId: event.id, sourceId: event.source_id, recordOrdinal: Number(event.record_ordinal),
          evidenceUri: event.evidence_uri, sessionId: event.session_id, kind: event.kind,
          status: event.status, actorKind: event.actor_kind, observedAt: event.observed_at,
          chunkIndex, text, contentHash,
          redactionState: text.includes("[REDACTED:") ? "REDACTED" : "SCANNED_REDACTED_PROJECTION",
        });
      }
    }
    return chunks;
  } finally { db.close(); }
}

function createProjectionSchema(db,dimensions) {
  boundedInteger(dimensions,'dimensions',2,65536);
  db.exec(native.readFileSync(new URL('../python/orbita_store/schemas/vector.sql',import.meta.url),'utf8'));
}

function legacyProjectionHash(db,manifest) {
  const declared=manifest.storage?.legacyProjectionHash;
  if(declared===undefined)return false;
  const columns=['start_cp','end_cp','token_count','representation_id','source_text_sha256'];
  if(!declared||declared.schema!=='sqlite-preview-without-fulltext-columns-1'||JSON.stringify(Object.keys(declared).sort())!==JSON.stringify(['absentColumns','schema'])||JSON.stringify(declared.absentColumns)!==JSON.stringify(columns)||manifest.config?.representation==='full_source_text')throw new Error('LEGACY_PROJECTION_HASH_FORMAT');
  const present=Number(db.prepare('SELECT COUNT(*) n FROM semantic_chunk WHERE start_cp IS NOT NULL OR end_cp IS NOT NULL OR token_count IS NOT NULL OR representation_id IS NOT NULL OR source_text_sha256 IS NOT NULL').get().n);
  if(present!==0)throw new Error('LEGACY_PROJECTION_COORDINATES_PRESENT');
  return true;
}

function computeProjectionHash(db,{legacyHash=false}={}) {
  // The original Node SQLite projection rows had a null prototype. Their
  // SELECT column order is part of the existing hash format: stableStringify
  // sorts plain objects, but deliberately leaves these rows in that order.
  // Preserve that format for both new builds and imported projections.
  const projection = db.prepare("SELECT id,case_hash,source_snapshot_hash,projection_schema_version,tool_version,provider_json,config_json FROM semantic_projection ORDER BY id").all().map(row=>Object.assign(Object.create(null),row));
  const chunks = db.prepare(`SELECT id,content_hash,embedding_rowid,event_id,source_id,record_ordinal,evidence_uri,
    session_id,event_kind,event_status,actor_kind,observed_at,chunk_index,text_sha256,redaction_state
    FROM semantic_chunk ORDER BY id`).all().map(normalizeBigInts);
  const embeddings = db.prepare("SELECT rowid,content_hash,vector_sha256,dimensions FROM semantic_embedding ORDER BY rowid").all().map(normalizeBigInts);
  const fullText = !legacyHash&&db.tableColumns("semantic_chunk").includes("start_cp") ? db.prepare("SELECT id,start_cp,end_cp,token_count,representation_id,source_text_sha256 FROM semantic_chunk ORDER BY id").all().map(normalizeBigInts) : null;
  return sha256(stableStringify({ projection, chunks, embeddings, ...(fullText ? {fullText} : {}) }));
}

function projectionResult(projectionDir, manifest) {
  return {
    projectionDir,
    projectionId: manifest.projectionId,
    projectionHash: manifest.projectionHash,
    model: manifest.model,
    metrics: manifest.metrics,
  };
}

function normalizeSearchText(text) {
  return preview(text, 100_000).text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function chunkText(text, maxChars, overlap) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      const boundary = text.lastIndexOf(" ", end);
      if (boundary > start + Math.floor(maxChars * 0.6)) end = boundary;
    }
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks.filter(Boolean);
}

function boundedBatches(entries, maxItems, maxChars) {
  const batches = [];
  let batch = [];
  let chars = 0;
  for (const entry of entries) {
    const length = String(entry[1]).length;
    if (batch.length && (batch.length >= maxItems || chars + length > maxChars)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(entry);
    chars += length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function vectorToBuffer(vector) {
  const buffer = Buffer.alloc(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) buffer.writeFloatLE(vector[index], index * 4);
  return buffer;
}

function bufferToVector(buffer) {
  const result = [];
  for (let offset = 0; offset < buffer.length; offset += 4) result.push(buffer.readFloatLE(offset));
  return result;
}

function passesChunkFilters(chunk, filters) {
  if(filters.scope!=="all" && chunk.event_kind==="forensic.alternative")return false;
  if (filters.session && chunk.session_id !== filters.session) return false;
  if (filters.kind && chunk.event_kind !== filters.kind) return false;
  if (filters.status && String(chunk.event_status || "") !== String(filters.status)) return false;
  if (filters.actor && String(chunk.actor_kind || "") !== String(filters.actor)) return false;
  if (filters.from && (!chunk.observed_at || chunk.observed_at < new Date(filters.from).toISOString())) return false;
  if (filters.to && (!chunk.observed_at || chunk.observed_at > new Date(filters.to).toISOString())) return false;
  if (filters.evidence === true && !chunk.evidence_uri) return false;
  return true;
}

function assertSameProvider(expected, actual) {
  const keys = ["provider", "runtime", "runtimeVersion", "modelId", "revision", "modelDigest", "dimensions", "dtype", "pooling", "normalization"];
  const differences = keys.filter((key) => String(expected[key]) !== String(actual[key]));
  if (differences.length) throw new SemanticUnavailableError(`Semantic provider does not match projection identity: ${differences.join(", ")}`);
}

function resolveProjectionDir(caseDir, explicit) {
  const target = explicit ? path.resolve(explicit) : findSemanticProjection(caseDir);
  if (!target) throw new SemanticUnavailableError("No complete semantic projection is available. Run 'afh semantic-index <case-dir>'.");
  return target;
}


function normalizeBigInts(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? Number(value) : value]));
}

function boundedInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  return parsed;
}

function boundedSimilarity(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < -1 || parsed > 1) throw new Error("minSimilarity must be between -1 and 1");
  return parsed;
}

function assertDirectChild(target, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) throw new Error(`Unsafe projection staging path: ${target}`);
}

function failedChecks(result) {
  return result.findings.filter((finding) => !finding.ok).map((finding) => finding.check).join(", ") || "unknown failure";
}
