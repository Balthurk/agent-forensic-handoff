import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {fileURLToPath} from 'node:url';
import {commonStoreHealth} from './common-store.js';
import { semanticModelStatus } from "./semantic-model.js";

export function doctor({root=process.env.AFH_COSMOS_DATA,modelHome=process.env.AFH_MODEL_HOME}={}) {
  const home = os.homedir();
  const checks = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "Node.js >=22", ok: major >= 22, required:true, detail: process.version });
  try{checks.push({name:'PostgreSQL common store',ok:true,required:true,detail:commonStoreHealth(root)});}
  catch(error){checks.push({name:'PostgreSQL common store',ok:false,required:true,detail:error.code||'ORBITA_PG_HEALTH_UNAVAILABLE'});}
  const model=semanticModelStatus({deep:false,modelHome:modelHome||fileURLToPath(new URL('../../runtime/models/',import.meta.url))});
  checks.push({name:'Local semantic model assets',ok:model.available,required:false,
    detail:{modelId:model.modelId,revision:model.revision,snapshotPath:model.snapshotPath,inferenceVerified:false}});
  checks.push({ name: "Zstandard", ok: typeof zlib.createZstdDecompress === "function", required:false, detail: typeof zlib.createZstdDecompress === "function" ? "node:zlib" : "requires external zstd binary" });
  for (const [name, target] of [
    ["Codex home", process.env.CODEX_HOME || path.join(home, ".codex")],
    ["Claude home", path.join(home, ".claude")],
    ["Antigravity home", path.join(home, ".gemini", "antigravity")],
  ]) checks.push({ name, ok: fs.existsSync(target), required:false, detail: target });
  return checks;
}
