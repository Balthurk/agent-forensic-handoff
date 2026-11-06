import test from 'node:test';
import assert from 'node:assert/strict';
import native from 'node:fs';
import path from 'node:path';
import {CaseDatabase} from '../src/database.js';
import {closeCommonStore} from '../src/common-store.js';

const root=process.env.ORBITA_POSTGRES_TEST_ROOT,opened=[];
const open=(name,options)=>{const db=new CaseDatabase(path.join(root,'case-api',name,'case.pgstore'),options);opened.push(db);return db;};
test.after(()=>{for(const db of opened)db.close();assert.equal(native.existsSync(root),false);closeCommonStore();});
function seed(db){
  db.insertRun({id:'run',schemaVersion:1,toolVersion:'fixture',config:{},sourceSnapshotHash:'source',startedAt:'now',status:'running'});
  db.insertSource({id:'source',harness:'generic',nativeUri:'explicit-input',kind:'file',rawSha256:'hash',byteLength:9,canonicalByteLength:9,compression:'none'});
  db.upsertSession({id:'session',nativeId:'native',harness:'generic',sourceId:'source',title:'Literal ñ'});
  db.upsertActor({id:'actor',kind:'human',role:'user',epistemic:'DIRECT_EVIDENCE'});
  db.insertRecord({sourceId:'source',ordinal:1,byteOffset:0,byteLength:9,sha256:'hash',parseStatus:'PARSED'});
  db.insertEvent({id:'event',sessionId:'session',sourceId:'source',recordOrdinal:1,timePrecision:'UNKNOWN',actorId:'actor',kind:'user.message',inputPreview:'Éxito alfa_beta revisión 😀',epistemic:'DIRECT_EVIDENCE'});
  db.insertEvidenceRef({id:'ref',eventId:'event',sourceId:'source',recordOrdinal:1,recordSha256:'hash',uri:'afh://source/1'});
}
test('CaseDatabase persists actual case methods and lexical joins in the common store',()=>{
  const db=open('literal');db.begin();seed(db);db.commit();
  const rows=db.all('SELECT e.id,e.input_preview,a.role FROM event_fts f JOIN event e ON e.id=f.event_id LEFT JOIN actor a ON a.id=e.actor_id WHERE event_fts MATCH $query AND ($session IS NULL OR e.session_id=$session) ORDER BY e.record_ordinal',{query:'"exito" AND "alfa_beta"',session:null});
  assert.deepEqual(rows,[{id:'event',input_preview:'Éxito alfa_beta revisión 😀',role:'user'}]);
  assert.equal(db.get('SELECT uri FROM evidence_ref WHERE event_id=$id',{id:'event'}).uri,'afh://source/1');db.close();
  const fresh=open('literal',{readOnly:true});assert.equal(fresh.get('SELECT count(*) n FROM event').n,1);
  assert.throws(()=>fresh.run("UPDATE event SET input_preview='tampered'"),{code:'ORBITA_PG_READ_ONLY'});
});
test('rollback clears case value caches and a new transaction writes the same identities',()=>{
  const db=open('rollback');db.begin();seed(db);db.rollback();assert.equal(db.get('SELECT count(*) n FROM event').n,0);
  db.begin();seed(db);db.commit();assert.equal(db.get('SELECT count(*) n FROM actor').n,1);
  assert.equal(db.get('SELECT count(*) n FROM session').n,1);
});
test('same forensic identifiers in another case stay isolated and enforce foreign keys',()=>{
  const a=open('isolate-a'),b=open('isolate-b');seed(a);assert.equal(b.get('SELECT count(*) n FROM event').n,0);
  assert.throws(()=>b.insertEvidenceRef({id:'ref',eventId:'event',sourceId:'source',recordOrdinal:1,recordSha256:'hash',uri:'afh://source/1'}),{code:'23503'});
  seed(b);b.run("UPDATE event SET input_preview='different'");assert.match(a.get('SELECT input_preview FROM event').input_preview,/Éxito/);
});
