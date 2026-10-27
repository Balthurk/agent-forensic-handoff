import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const root=path.resolve(process.argv[2]),packages=path.resolve(process.argv[3]);assert.ok(path.isAbsolute(process.argv[2])&&path.isAbsolute(process.argv[3]));assert.ok(!fs.existsSync(root));fs.mkdirSync(root);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function inventory(dir){const result=[];const walk=current=>{for(const name of fs.readdirSync(current).sort()){const file=path.join(current,name),stat=fs.lstatSync(file);assert.equal(stat.isSymbolicLink(),false);if(stat.isDirectory())walk(file);else result.push({path:path.relative(dir,file),bytes:stat.size,sha256:hash(fs.readFileSync(file))});}};walk(dir);return result;}
const report={role:'SYNTHETIC_LEGACY_INPUT_PREPARATION',acceptance_eligible:false,node:process.version,platform:process.platform,versions:[],builder_sha256:hash(fs.readFileSync(fileURLToPath(import.meta.url)))};
for(const [version,schema,commit]of [['0.1.0',1,'ba2ae318d1fa1cb1264134827ca756aba58e6a79'],['0.2.0',2,'7f66e72effc8bd698e915db9b1f870dccffd5db6'],['0.3.0',3,'d0e444e65ccddf2ed42a5221dccd4d94c1b622c9']]){
  const packageRoot=path.join(packages,'package-'+version);assert.equal(JSON.parse(fs.readFileSync(path.join(packages,'identities.json')))[version],commit);
  const packageBefore=inventory(packageRoot);assert.equal(JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'))).version,version);
  const api=await import(pathToFileURL(path.join(packageRoot,'src/index.js')).href);
  const input=path.join(root,'input-'+version+'.jsonl');
  const records=[{session_id:'synthetic-legacy-'+version,role:'user',content:'Preserve original legacy source.'},{session_id:'synthetic-legacy-'+version,role:'assistant',content:'Synthetic fixture with evidence only.'}];
  const bytes=records.map(JSON.stringify).join('\n')+'\n';fs.writeFileSync(input,bytes,{flag:'wx'});
  const result=await api.auditSession(input,{harness:'generic',caseDir:path.join(root,'case-'+version),workspace:root,includeChildren:false});
  const manifest=JSON.parse(fs.readFileSync(path.join(result.caseDir,'case.json')));assert.equal(manifest.schemaVersion,schema);
  const before=inventory(result.caseDir),db=new DatabaseSync(path.join(result.caseDir,'case.sqlite'),{readOnly:true});
  const refs=db.prepare('SELECT * FROM evidence_ref').all().map(row=>({...row}));const events=db.prepare('SELECT id FROM event ORDER BY id').all().map(row=>row.id);
  const integrity=db.prepare('PRAGMA integrity_check').all();assert.equal(integrity[0].integrity_check,'ok');assert.equal(db.prepare('SELECT schema_version FROM ingest_run LIMIT 1').get().schema_version,schema);db.close();
  const evidence=refs.map(ref=>{const read=api.readEvidence(result.caseDir,ref.uri);return {uri:ref.uri,text:read.text,sha256:hash(read.text)};});assert.ok(evidence.length>=records.length);
  assert.deepEqual(inventory(result.caseDir),before);assert.deepEqual(inventory(packageRoot),packageBefore);assert.equal(fs.readFileSync(input,'utf8'),bytes);
  report.versions.push({version,schema,commit,package_root:packageRoot,package_inventory:packageBefore,input,input_sha256:hash(bytes),case_dir:result.caseDir,case_hash:result.caseHash,case_inventory:before,legacy_event_ids:events,evidence});
}
report.status='INPUTS_PREPARED_NOT_IMPORT_ACCEPTANCE';fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:report.status,versions:report.versions.map(v=>({version:v.version,schema:v.schema,refs:v.evidence.length,events:v.legacy_event_ids.length}))},null,2));
