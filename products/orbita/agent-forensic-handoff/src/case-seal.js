import path from 'node:path';
import {transactionIO} from './common-transaction.js';
import {stableStringify} from './util.js';

export function caseSealPath(root,rows){
  if(rows?.format!=='orbita-common-rows-1'||rows.family!=='case'||!/^[a-f0-9]{64}$/.test(rows.sha256))throw new Error('CASE_INTEGRITY_FAILED: Invalid typed row manifest');
  return path.join(root,'case-seals',rows.sha256+'.json');
}
export function publishCaseManifest(db,root,manifest){
  const io=transactionIO(db),rows=db.logicalManifest();
  manifest.storage={engine:'postgresql-common',path:'case.pgstore',manifest:rows};
  const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n'),receipt=caseSealPath(root,rows);
  try{io.atomicWrite(receipt,bytes,{exclusive:true});}
  catch(error){
    if(error.code!=='EEXIST')throw error;
    if(!io.readFile(receipt).equals(bytes))throw new Error('CASE_INTEGRITY_FAILED: Immutable full seal differs');
  }
  io.atomicWrite(path.join(root,'case.json'),bytes);return manifest;
}
export function exactCaseSeal(db,root,manifest,actual){
  const io=transactionIO(db),candidate=io.readJson(caseSealPath(root,actual));
  if(!candidate||candidate.status!=='COMPLETE'||candidate.storage?.engine!=='postgresql-common'||candidate.storage?.path!=='case.pgstore')return null;
  if(stableStringify(candidate.storage.manifest)!==stableStringify(actual))return null;
  // Recovery can advance derived state, never replace source/config/identity.
  const fixed=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!['metrics','graphIdentity','temporalIdentity','storage','hydrationPackId'].includes(key)));
  if(stableStringify(fixed(candidate))!==stableStringify(fixed(manifest)))return null;
  return candidate;
}
