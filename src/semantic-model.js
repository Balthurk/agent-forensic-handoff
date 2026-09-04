import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { ensureDir, sha256, stableStringify, walkFiles } from "./util.js";

const require = createRequire(import.meta.url);

export const KNOWN_SEMANTIC_MODELS = Object.freeze({
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2": Object.freeze({
    modelId: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    revision: "2c4055b12046f11709e9df2c122e59ffbdc2f900",
    dimensions: 384,
    dtype: "q8",
    pooling: "mean",
    normalization: "l2-v1",
    license: "Apache-2.0 (upstream sentence-transformers model)",
  }),
  "Xenova/all-MiniLM-L6-v2": Object.freeze({
    modelId: "Xenova/all-MiniLM-L6-v2",
    revision: "751bff37182d3f1213fa05d7196b954e230abad9",
    dimensions: 384,
    dtype: "q8",
    pooling: "mean",
    normalization: "l2-v1",
    license: "Apache-2.0",
  }),
});

export const DEFAULT_SEMANTIC_MODEL = KNOWN_SEMANTIC_MODELS["Xenova/paraphrase-multilingual-MiniLM-L12-v2"];

export class SemanticUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "SemanticUnavailableError";
    this.code = "SEMANTIC_UNAVAILABLE";
  }
}

export async function createTransformersProvider(options = {}) {
  const model = resolveModelConfig(options);
  const modelHome = path.resolve(options.modelHome || process.env.AFH_MODEL_HOME || path.join(os.homedir(), ".afh", "models"));
  const snapshotPath = semanticModelSnapshotPath(modelHome, model.modelId, model.revision);
  const allowDownload = options.allowDownload === true;
  if (!allowDownload && !modelSnapshotLooksComplete(snapshotPath)) {
    throw new SemanticUnavailableError(`Exact local semantic model snapshot is unavailable: ${snapshotPath}. Run 'afh semantic-model fetch' explicitly.`);
  }

  let transformers;
  try { transformers = await import("@huggingface/transformers"); }
  catch (error) { throw new SemanticUnavailableError(`Optional local embedding runtime is unavailable: ${error.message || error}`); }
  const { env, pipeline } = transformers;
  ensureDir(modelHome);
  env.allowLocalModels = true;
  env.cacheDir = modelHome;
  let pipelineModel;
  let pipelineOptions;
  if (allowDownload) {
    env.allowRemoteModels = true;
    pipelineModel = model.modelId;
    pipelineOptions = { revision: model.revision, dtype: model.dtype };
  } else {
    env.allowRemoteModels = false;
    const [namespace, ...nameParts] = model.modelId.split("/");
    env.localModelPath = path.join(modelHome, namespace);
    pipelineModel = `${nameParts.join("/")}/${model.revision}`;
    pipelineOptions = { dtype: model.dtype };
  }

  let extractor;
  try { extractor = await pipeline("feature-extraction", pipelineModel, pipelineOptions); }
  catch (error) {
    throw new SemanticUnavailableError(`Unable to load exact local embedding model ${model.modelId}@${model.revision}: ${error.message || error}`);
  } finally {
    // Inference is local. Disable any further remote model access after the explicit load/fetch step.
    env.allowRemoteModels = false;
  }
  if (!modelSnapshotLooksComplete(snapshotPath)) {
    try { await extractor.dispose?.(); } catch {}
    throw new SemanticUnavailableError(`Model load completed without a verifiable immutable snapshot at ${snapshotPath}`);
  }
  const modelDigest = digestDirectory(snapshotPath);
  const runtimeVersion = packageVersion("@huggingface/transformers") || "UNAVAILABLE";
  return {
    identity: {
      provider: "transformers-local",
      runtime: "@huggingface/transformers",
      runtimeVersion,
      modelId: model.modelId,
      revision: model.revision,
      modelDigest,
      dimensions: model.dimensions,
      dtype: model.dtype,
      pooling: model.pooling,
      normalization: model.normalization,
      license: model.license,
      snapshotPath,
    },
    async embed(texts) {
      const values = Array.isArray(texts) ? texts : [texts];
      if (!values.length) return [];
      const tensor = await extractor(values, { pooling: model.pooling, normalize: true });
      return tensor.tolist();
    },
    async dispose() { await extractor.dispose?.(); },
  };
}

export async function fetchSemanticModel(options = {}) {
  const provider = await createTransformersProvider({ ...options, allowDownload: true });
  try {
    const vectors = await provider.embed(["AFH local semantic model installation canary."]);
    validateProviderVectors(vectors, provider.identity.dimensions, 1);
    return { status: "INSTALLED", model: provider.identity };
  } finally { await provider.dispose?.(); }
}

export function semanticModelStatus(options = {}) {
  const model = resolveModelConfig(options);
  const modelHome = path.resolve(options.modelHome || process.env.AFH_MODEL_HOME || path.join(os.homedir(), ".afh", "models"));
  const snapshotPath = semanticModelSnapshotPath(modelHome, model.modelId, model.revision);
  const available = modelSnapshotLooksComplete(snapshotPath);
  return {
    available,
    modelId: model.modelId,
    revision: model.revision,
    dimensions: model.dimensions,
    dtype: model.dtype,
    snapshotPath,
    modelDigest: available && options.deep === true ? digestDirectory(snapshotPath) : null,
    digestVerified: available && options.deep === true,
  };
}

export function semanticModelSnapshotPath(modelHome, modelId, revision) {
  const parts = String(modelId).split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("modelId must include a namespace and name");
  return path.join(path.resolve(modelHome), ...parts, revision);
}

export function validateProviderIdentity(identity) {
  const required = ["provider", "runtime", "runtimeVersion", "modelId", "revision", "modelDigest", "dimensions", "dtype", "pooling", "normalization"];
  for (const key of required) if (identity?.[key] == null || identity[key] === "") throw new Error(`Embedding provider identity is missing ${key}`);
  if (!/^[a-f0-9]{64}$/i.test(String(identity.modelDigest))) throw new Error("Embedding provider modelDigest must be a SHA-256 value");
  if (!Number.isSafeInteger(Number(identity.dimensions)) || Number(identity.dimensions) < 2 || Number(identity.dimensions) > 65_536) throw new Error("Embedding provider dimensions are invalid");
  return identity;
}

export function validateProviderVectors(vectors, dimensions, expectedCount) {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) throw new Error(`Embedding provider returned ${vectors?.length ?? "invalid"} vectors; expected ${expectedCount}`);
  return vectors.map((value, index) => {
    const vector = Array.from(value);
    if (vector.length !== Number(dimensions)) throw new Error(`Embedding vector ${index} has ${vector.length} dimensions; expected ${dimensions}`);
    if (!vector.every(Number.isFinite)) throw new Error(`Embedding vector ${index} must contain only finite values`);
    return vector;
  });
}

export function digestDirectory(root) {
  const absolute = path.resolve(root);
  const files = walkFiles(absolute).map((file) => {
    const relative = path.relative(absolute, file).replaceAll(path.sep, "/");
    const bytes = fs.readFileSync(file);
    return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
  });
  if (!files.length) throw new Error(`Model snapshot contains no files: ${absolute}`);
  return sha256(stableStringify(files));
}

export function modelSnapshotLooksComplete(snapshotPath) {
  return fs.existsSync(path.join(snapshotPath, "config.json"))
    && fs.existsSync(path.join(snapshotPath, "tokenizer.json"))
    && fs.existsSync(path.join(snapshotPath, "tokenizer_config.json"))
    && fs.existsSync(path.join(snapshotPath, "onnx", "model_quantized.onnx"));
}

function resolveModelConfig(options) {
  const requested = String(options.model || options.modelId || DEFAULT_SEMANTIC_MODEL.modelId);
  const known = KNOWN_SEMANTIC_MODELS[requested];
  if (!known && (!options.revision || !options.dimensions)) {
    throw new Error(`Unknown semantic model '${requested}'; provide an exact revision and dimensions`);
  }
  return {
    ...(known || {}),
    modelId: requested,
    revision: options.revision || known?.revision,
    dimensions: Number(options.dimensions || known?.dimensions),
    dtype: options.dtype || known?.dtype || "q8",
    pooling: options.pooling || known?.pooling || "mean",
    normalization: options.normalization || known?.normalization || "l2-v1",
    license: options.license || known?.license || "UNAVAILABLE",
  };
}

function packageVersion(name) {
  try {
    let current = path.dirname(require.resolve(name));
    while (path.dirname(current) !== current) {
      const candidate = path.join(current, "package.json");
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
        if (parsed.name === name) return parsed.version;
      }
      current = path.dirname(current);
    }
  } catch {}
  return null;
}
