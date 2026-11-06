import path from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import files from '../agent-forensic-handoff/src/common-files.js';
import {objectOperation} from '../agent-forensic-handoff/src/common-store.js';
import {checkpoint} from './common-durable.mjs';

// The content ID remains the hash of the original JSON bytes. A new signing
// key is published with those bytes in one namespace transaction; a competing
// publisher never replaces an existing key or an already issued cursor.
export function publishSnapshot(root,id,raw){
 root=path.resolve(root);
 if(typeof raw!=='string'||!/^[a-f0-9]{64}$/.test(id)||createHash('sha256').update(raw).digest('hex')!==id)throw new Error('SNAPSHOT_PUBLICATION_IDENTITY');
 if(Buffer.byteLength(raw)>32000000)throw new Error('SNAPSHOT_PUBLICATION_BUDGET');
 const destination=path.join(root,id);files.mkdirSync(root,{recursive:true});
 if(files.existsSync(destination))return false;
 const name='.snapshot-'+id+'-'+randomUUID(),stage=path.join(root,name);let owned=false;
 try{
  files.mkdirSync(stage);owned=true;files.writeFileSync(path.join(stage,'snapshot.json'),raw,{flag:'wx'});checkpoint('snapshot-after-body');
  files.writeFileSync(path.join(stage,'cursor.key'),randomBytes(32),{flag:'wx'});checkpoint('snapshot-after-key');
  try{objectOperation('rename',stage,{target:destination,replace:false});}catch(error){if(error.code==='EEXIST')return false;throw error;}
  checkpoint('snapshot-after-publish');return true;
 }finally{
  if(owned&&files.existsSync(stage)){
   if(path.dirname(stage)!==root||path.basename(stage)!==name)throw new Error('SNAPSHOT_CLEANUP_SCOPE');
   files.rmSync(stage,{recursive:true,force:false});
  }
 }
}
