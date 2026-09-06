import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {inside,readJson,putObject,saveSourceManifest,CHUNK_BYTES} from './storage.js';
import {digest,hash,failure} from './protocol.js';

function inventory(root,limit){
  const rows=[];let total=0;
  function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const relative=path.relative(root,path.join(dir,entry.name)),file=inside(root,relative);if(entry.isDirectory())walk(file);else if(entry.isFile()){if(total+fs.statSync(file).size>limit)throw failure('LIMIT_EXCEEDED','Legacy case inventory exceeds job limit');const fd=fs.openSync(file,'r'),hasher=createHash('sha256'),buffer=Buffer.alloc(CHUNK_BYTES);let length=0;try{for(let n;(n=fs.readSync(fd,buffer,0,buffer.length,null))>0;){if(total+length+n>limit)throw failure('LIMIT_EXCEEDED','Legacy case grew beyond job limit');hasher.update(buffer.subarray(0,n));length+=n;}}finally{fs.closeSync(fd);}total+=length;rows.push({path:relative.replaceAll(path.sep,'/'),bytes:length,sha256:hasher.digest('hex')});}else throw failure('INVALID_REQUEST','Legacy case contains unsupported filesystem objects');}}
  walk(root);return rows;
}
function preserveFile(root,file,limit){
  const fd=fs.openSync(file,'r'),objects=[],hasher=createHash('sha256'),buffer=Buffer.alloc(CHUNK_BYTES);let length=0;
  try{for(let n;(n=fs.readSync(fd,buffer,0,buffer.length,null))>0;){if(length+n>limit)throw failure('LIMIT_EXCEEDED','Legacy source exceeds acquisition limit');const bytes=buffer.subarray(0,n),object=putObject(root,bytes);delete object.reused;objects.push({...object,offset:length});length+=n;hasher.update(bytes);}}finally{fs.closeSync(fd);}return {objects,bytes:length,sha256:hasher.digest('hex')};
}
export function inspectLegacy(caseRoot){const metadata=readJson(inside(caseRoot,'case.json'));if(![1,2,3].includes(metadata.schemaVersion))throw failure('UNSUPPORTED_VERSION','Legacy case schema version is unsupported');if(!/^[a-f0-9]{64}$/.test(metadata.caseHash))throw failure('INTEGRITY_FAILED','Legacy case hash is invalid');return metadata;}
export function prepareLegacyImport(root,caseRoot,limits){
  const metadata=inspectLegacy(caseRoot),before=inventory(caseRoot,limits.max_job_bytes),beforeHash=digest(before),db=new DatabaseSync(inside(caseRoot,'case.sqlite'),{readOnly:true});const sources=[],aliases=[];let consumed=0;
  try{
    db.exec('BEGIN');
    const check=db.prepare('PRAGMA integrity_check').all();if(check.length!==1||check[0].integrity_check!=='ok')throw failure('INTEGRITY_FAILED','Legacy database integrity check failed');
    for(const old of db.prepare('SELECT * FROM source ORDER BY id').all()){
      const evidencePath=old.evidence_path??`evidence/sources/${old.raw_sha256}.jsonl`;
      if(path.isAbsolute(evidencePath)||evidencePath.includes(':'))throw failure('INTEGRITY_FAILED','Legacy evidence path must stay inside its case');
      const captured=preserveFile(root,inside(caseRoot,evidencePath),limits.max_decoded_source_bytes);consumed+=captured.bytes;if(consumed>limits.max_job_bytes)throw failure('LIMIT_EXCEEDED','Legacy import exceeds job limit');
      if(captured.sha256!==(old.canonical_sha256??old.raw_sha256)||captured.bytes!==Number(old.canonical_byte_length??old.byte_length))throw failure('INTEGRITY_FAILED','Legacy canonical evidence differs from its source row');
      const lineage='legacy4-'+digest([metadata.caseHash,old.id]),sessionId='ses4-'+digest([metadata.caseHash,old.id,'legacy-source']),originId=metadata.caseHash.slice(0,8)+'-'+metadata.caseHash.slice(8,12)+'-4'+metadata.caseHash.slice(13,16)+'-8'+metadata.caseHash.slice(17,20)+'-'+metadata.caseHash.slice(20,32);
      const counts={records_preserved:0,records_parsed:0,records_unparsed:0,records_normalized:0,records_unsupported:0},records=[],fd=fs.openSync(inside(caseRoot,evidencePath),'r');
      try{for(const record of db.prepare('SELECT * FROM source_record WHERE source_id=? ORDER BY ordinal').all(old.id)){
        if(!Number.isSafeInteger(record.byte_length)||record.byte_length<0||record.byte_length>limits.max_record_bytes||record.byte_offset+record.byte_length>captured.bytes)throw failure('INTEGRITY_FAILED','Legacy record extent exceeds its captured bytes');
        const bytes=Buffer.alloc(record.byte_length);if(fs.readSync(fd,bytes,0,bytes.length,record.byte_offset)!==bytes.length||hash(bytes)!==record.sha256)throw failure('INTEGRITY_FAILED','Legacy record digest differs');
        const oldEvents=db.prepare('SELECT * FROM event WHERE source_id=? AND record_ordinal=? ORDER BY subordinal,id').all(old.id,record.ordinal);
        const events=oldEvents.map(event=>({id:'evt4-'+digest([metadata.caseHash,event.id]),session_id:'ses4-'+digest([metadata.caseHash,event.session_id]),kind:event.kind,native_id:event.native_id??null,legacy_event_id:event.id,legacy_schema_version:metadata.schemaVersion,legacy_event:{...event},mapping_grade:'EXACT_LEGACY_ALIAS'}));
        const parsed=record.parse_status==='PARSED';counts.records_preserved++;counts[parsed?'records_parsed':'records_unparsed']++;if(parsed)counts[events.some(e=>!e.kind.startsWith('forensic.'))?'records_normalized':'records_unsupported']++;
        records.push({ordinal:record.ordinal,byte_offset:record.byte_offset,byte_length:record.byte_length,sha256:record.sha256,original_extent_bytes:record.byte_length,includes_terminator:false,parse_status:record.parse_status,normalization_status:'LEGACY_PRESERVED',identity_epoch:'legacy4-'+metadata.caseHash,legacy_uri:`afh://evidence/sha256/${old.raw_sha256}/record/${record.ordinal}#bytes=${record.byte_offset}:${record.byte_length}`,events});
      }}finally{fs.closeSync(fd);}
      const source=saveSourceManifest(root,{schema_version:4,source_lineage_id:lineage,harness:old.harness,origin_domain_id:originId,native_id:null,session_id:sessionId,identity_status:'UNCERTAIN',provisional:true,raw_sha256:captured.sha256,raw_bytes:captured.bytes,codec:'none',objects:captured.objects,decoded_manifest_id:null,decoded_sha256:captured.sha256,decoded_bytes:captured.bytes,decoded_objects:[],boundary:{kind:'LEGACY_CANONICAL_CAPTURE',bytes:captured.bytes},legacy_raw_sha256:old.raw_sha256,legacy_case_hash:metadata.caseHash,legacy_schema_version:metadata.schemaVersion,legacy_source:{...old},records,counts});sources.push(source);
      for(const record of source.records)for(const event of record.events)aliases.push({legacy_event_id:event.legacy_event_id,event_id:event.id,mapping_grade:'EXACT_LEGACY_ALIAS',evidence_refs:[record.evidence_ref]});
    }
    const total=db.prepare('SELECT count(*) AS n FROM event').get().n;if(aliases.length!==total)throw failure('INTEGRITY_FAILED','Not every legacy event resolves to a preserved source record');
    db.exec('COMMIT');
  }finally{db.close();}
  // Preserve the original report, SQLite bytes and every supplemental artifact.
  // Their meaning and normalization grade remain the legacy producer's own.
  const artifacts=before.map(item=>{const captured=preserveFile(root,inside(caseRoot,item.path),limits.max_job_bytes);if(captured.sha256!==item.sha256||captured.bytes!==item.bytes)throw failure('INTEGRITY_FAILED','Legacy artifact changed during import');return {...item,objects:captured.objects};});
  const after=inventory(caseRoot,limits.max_job_bytes),afterHash=digest(after);if(afterHash!==beforeHash)throw failure('INTEGRITY_FAILED','Legacy case inventory changed during import');
  return {metadata,sources,aliases,artifacts,source_inventory_before:beforeHash,source_inventory_after:afterHash};
}
