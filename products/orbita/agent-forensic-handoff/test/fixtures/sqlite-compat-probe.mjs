import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const [moduleUrl, mode, root] = process.argv.slice(2);
const { DatabaseSync } = await import(moduleUrl);
const nativeAvailable = Boolean(process.getBuiltinModule('node:sqlite')?.DatabaseSync);
const file = path.join(root, 'source with spaces.sqlite');
const result = { nativeAvailable };
const plain = value => JSON.parse(JSON.stringify(value));
if (mode === 'ingest') {
  const {auditSession,verifyCaseIntegrity,searchCase,readUnifiedEvidence,exportN01Packet}=await import(new URL('index.js',moduleUrl));
  const message=(id,role,text)=>({id,author:{role},create_time:1700000000,content:{content_type:'text',parts:[text]},status:'finished_successfully'});
  const text='I02unicode á 漢 😀 e\u0301; conservar "todo"\nLínea dos';
  const conversation={id:'i02-synthetic',title:'I02 native/fallback',current_node:'a',mapping:{
    root:{id:'root',parent:null,children:['u'],message:null},
    u:{id:'u',parent:'root',children:['a','b'],message:message('m-u','user',text)},
    a:{id:'a',parent:'u',children:[],message:message('m-a','assistant','I02active SQLite')},
    b:{id:'b',parent:'u',children:[],message:message('m-b','assistant','I02alternative PostgreSQL')},
  }};
  const raw=JSON.stringify(conversation,null,4)+'\r\n',input=path.join(root,'original.json');
  fs.writeFileSync(input,raw);
  const dest=(await auditSession(input,{caseDir:path.join(root,'case')})).caseDir;
  result.originalExact=fs.readFileSync(path.join(dest,'acquisition/original.bin'),'utf8')===raw;
  result.integrity=(await verifyCaseIntegrity(dest)).passed;
  const id=JSON.parse(fs.readFileSync(path.join(dest,'identity.json'))).representations.find(r=>r.message_id==='m-u');
  result.quote=(await readUnifiedEvidence(dest,id.representation_id)).quote;
  const emoji=[...text].indexOf('😀');
  result.emoji=(await readUnifiedEvidence(dest,id.representation_id,{start:emoji,end:emoji+1})).quote;
  result.activeSearch=searchCase(dest,'I02active').length;
  result.alternativeDefault=searchCase(dest,'I02alternative').length;
  result.alternativeAll=searchCase(dest,'I02alternative',25,{scope:'all'}).length;
  result.beforeRegistration=(await exportN01Packet([dest],{knownAt:'2020-01-01T00:00:00Z'})).records.length;
  assert.equal(result.quote,text);
} else if (mode === 'matrix') {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE item(id INTEGER PRIMARY KEY, value TEXT, version INTEGER DEFAULT 1);
    CREATE TABLE audit(value TEXT);
    -- A semicolon ; in a comment is not a statement boundary.
    CREATE TRIGGER recorded AFTER INSERT ON item BEGIN
      INSERT INTO audit VALUES('first; ' || new.value);
      INSERT INTO audit VALUES('second; ''quoted''');
    END;
    /* another ; comment */ INSERT INTO item(value) VALUES('left;right');
    INSERT INTO item(value) VALUES('tail;without terminator')
  `);
  const text = 'Español á 漢字 😀 e\u0301; "quoted"\nsecond line';
  result.insert = db.prepare('INSERT INTO item(value) VALUES(?)').run(text);
  result.zeroUpdate = db.prepare('UPDATE item SET value=? WHERE id=999').run('absent');
  result.cas = [];
  const other = new DatabaseSync(file);
  const old = other.prepare('SELECT version FROM item WHERE id=3').get().version;
  result.cas.push(db.prepare('UPDATE item SET version=version+1 WHERE id=3 AND version=?').run(old).changes);
  result.cas.push(other.prepare('UPDATE item SET version=version+1 WHERE id=3 AND version=?').run(old).changes);
  other.close();
  const before = plain(db.prepare('SELECT * FROM item ORDER BY id').all());
  const auditBefore = plain(db.prepare('SELECT * FROM audit ORDER BY rowid').all());
  db.exec('BEGIN');
  db.exec("INSERT INTO item(value) VALUES('rollback; me'); SAVEPOINT inner;");
  db.exec("INSERT INTO item(value) VALUES('also rollback'); ROLLBACK TO inner; RELEASE inner;");
  db.exec('ROLLBACK');
  result.rollback = plain(db.prepare('SELECT * FROM item ORDER BY id').all());
  result.rollbackAudit = plain(db.prepare('SELECT * FROM audit ORDER BY rowid').all());
  assert.deepEqual(result.rollback, before);
  assert.deepEqual(result.rollbackAudit, auditBefore);
  let scriptError;
  try { db.exec("BEGIN; INSERT INTO item(value) VALUES('first survives until rollback'); INVALID SQL; INSERT INTO item(value) VALUES('never');"); }
  catch (error) { scriptError = error.message; }
  assert.ok(scriptError);
  result.partialInsideTransaction = db.prepare('SELECT count(*) AS n FROM item').get().n;
  db.exec('ROLLBACK');
  result.afterErrorRollback = db.prepare('SELECT count(*) AS n FROM item').get().n;
  db.exec('BEGIN');
  assert.throws(() => db.prepare('INSERT INTO item(id,value) VALUES(1,?)').run('duplicate'));
  result.afterConstraint = db.prepare('SELECT count(*) AS n FROM item').get().n;
  db.exec('ROLLBACK');
  result.returningRun = db.prepare('INSERT INTO item(value) VALUES(?),(?) RETURNING id').run('one','two');
  result.returningGet = plain(db.prepare('INSERT INTO item(value) VALUES(?),(?) RETURNING id').get('three','four'));
  result.returningAll = plain(db.prepare('INSERT INTO item(value) VALUES(?) RETURNING id,value').all('five'));
  result.selectRun = db.prepare('SELECT * FROM item').run();
  result.ddlRun = db.prepare('CREATE TABLE bytes(data BLOB)').run();
  const bytes = new Uint8Array([0, 255, 13, 10, 128, 1]);
  result.blobInsert = db.prepare('INSERT INTO bytes VALUES($data)').run({$data:bytes});
  result.blob = Array.from(db.prepare('SELECT data FROM bytes').get().data);
  result.unicode = db.prepare('SELECT value FROM item WHERE id=3').get().value;
  const long = text.repeat(6000);
  db.prepare('UPDATE item SET value=? WHERE id=3').run(long);
  result.largeUnicodeExact = db.prepare('SELECT value FROM item WHERE id=3').get().value === long;
  result.rows = plain(db.prepare('SELECT id,version FROM item ORDER BY id').all());
  result.audit = plain(db.prepare('SELECT * FROM audit ORDER BY rowid').all());
  const stale = db.prepare('SELECT 1 AS n');
  db.close();
  assert.throws(() => stale.get());
  const readonly = new DatabaseSync(file, { readOnly: true });
  result.readonlyRows = plain(readonly.prepare('SELECT id,version FROM item ORDER BY id').all());
  assert.throws(() => readonly.prepare('DELETE FROM item').run());
  readonly.close();
} else if (mode === 'nul') {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(value TEXT)');
  const text='before\u0000after';
  db.prepare('INSERT INTO t VALUES(?)').run(text);
  result.value=db.prepare('SELECT value FROM t').get().value;
  result.exact=result.value===text;
  db.close();
} else if (mode === 'open-failure') {
  const start = performance.now();
  try { new DatabaseSync(':memory:'); assert.fail('backend unexpectedly opened'); }
  catch (error) { result.error = {code:error.code,message:error.message}; }
  result.ms = performance.now() - start;
} else if (mode === 'fault') {
  const db = new DatabaseSync(file), sibling = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE committed(value TEXT)');
  const retained = db.prepare('SELECT count(*) AS n FROM committed');
  const fault = process.env.ORBITA_SQLITE_PROBE_FAULT;
  process.env.AFH_SQLITE_TIMEOUT_MS = '600';
  const start = performance.now();
  try { db.prepare("INSERT INTO committed VALUES('only once') /* fault-point */").run(); assert.fail('fault did not interrupt request'); }
  catch(error) { result.error = {code:error.code,message:error.message}; }
  result.ms = performance.now() - start;
  assert.throws(() => retained.get(), {code:'SQLITE_BACKEND_LOST'});
  assert.throws(() => sibling.exec('CREATE TABLE hijack(n)'), {code:'SQLITE_BACKEND_LOST'});
  process.env.AFH_SQLITE_TIMEOUT_MS = '10000';
  const reopened = new DatabaseSync(file);
  result.persisted = reopened.prepare('SELECT * FROM committed').all();
  result.expectedPersisted = fault === 'after-commit-exit' || fault === 'invalid-response' ? 1 : 0;
  assert.equal(result.persisted.length, result.expectedPersisted);
  assert.throws(() => retained.get(), {code:'SQLITE_BACKEND_LOST'});
  db.close(); sibling.close(); reopened.close();
  const trace = () => fs.existsSync(process.env.ORBITA_SQLITE_PROBE_TRACE) ? fs.readFileSync(process.env.ORBITA_SQLITE_PROBE_TRACE,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  for (let n=0; n<40; n++) {
    const rows=trace(), killed=rows.find(r=>r.event==='fault');
    if (killed && rows.some(r=>r.event==='child-close'&&r.pid===killed.pid)) break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  result.trace=trace();
  const victim=result.trace.find(r=>r.event==='fault');
  assert.ok(victim && result.trace.some(r=>r.event==='child-close'&&r.pid===victim.pid),'owned failed backend must close');
} else {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(value TEXT)');
  const text = 'fragmentación 😀 á 漢 e\u0301'.repeat(7000);
  db.prepare('INSERT INTO t VALUES(?)').run(text);
  result.exact = db.prepare('SELECT value FROM t').get().value === text;
  db.close();
}
console.log(JSON.stringify(result));
