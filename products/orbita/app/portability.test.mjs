import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const candidate=process.env.AFH_I03_CANDIDATE||fileURLToPath(new URL('../',import.meta.url));
const llm=pathToFileURL(path.join(candidate,'app','llm.mjs')).href;
function owned(t){
 const parent=fs.realpathSync(process.env.AFH_TEST_ROOT||os.tmpdir());
 const root=fs.mkdtempSync(path.join(parent,'orbita-i03-startup-'));
 t.after(()=>{assert.equal(path.dirname(fs.realpathSync(root)),parent);assert.ok(path.basename(root).startsWith('orbita-i03-startup-'));fs.rmSync(root,{recursive:true,force:true});});
 return root;
}
function probe(root,script,{local,managed=false}={}){
 const env={...process.env,AFH_COSMOS_DATA:path.join(root,'unopened data'),AFH_MANAGED:managed?'1':'0'};
 for(const key of ['LOCALAPPDATA','NODE_OPTIONS','OPENAI_API_KEY','CODEX_API_KEY'])delete env[key];
 if(local!==undefined)env.LOCALAPPDATA=local;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script,llm],{env,encoding:'utf8',windowsHide:true,timeout:20000});
 assert.equal(result.status,0,JSON.stringify({error:result.error?.message,stdout:result.stdout,stderr:result.stderr}));
 assert.equal(fs.existsSync(env.AFH_COSMOS_DATA),false,'auth/import must not create an inference job');
 return JSON.parse(result.stdout);
}
const imports="import assert from 'node:assert/strict';import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';";
for(const mode of ['variable absent','installation absent','runtime path is a file']){
 test('I03 local library can import LLM module with '+mode,t=>{
  const root=owned(t);let local;
  if(mode==='installation absent'){local=path.join(root,'empty local appdata with spaces');fs.mkdirSync(local);}
  if(mode==='runtime path is a file'){local=path.join(root,'not a folder');fs.writeFileSync(local,'synthetic');}
  const result=probe(root,imports+"let calls=0;cp.spawnSync=()=>{calls++;throw new Error('unexpected child')};syncBuiltinESMExports();const m=await import(process.argv[1]);const status=m.authStatus();assert.equal(status.connected,false);assert.equal(status.code,'CODEX_UNAVAILABLE');assert.equal(calls,0);console.log(JSON.stringify({imported:true,status,children:calls}));",{local});
  assert.equal(result.imported,true);assert.equal(result.children,0);
 });
}
test('I03 inaccessible installation is checked lazily and reports unavailable',t=>{
 const root=owned(t),local=path.join(root,'owned permission simulation');
 const result=probe(root,imports+"let reads=0;fs.readdirSync=()=>{reads++;const e=new Error('owned denial');e.code='EACCES';throw e;};const m=await import(process.argv[1]);assert.equal(reads,0);const status=m.authStatus();assert.equal(status.code,'CODEX_UNAVAILABLE');assert.equal(reads,1);console.log(JSON.stringify({status,reads}));",{local});
 assert.equal(result.reads,1);
});
test('I03 lazy Codex resolution selects the newest regular executable and strips API keys',t=>{
 const root=owned(t),local=path.join(root,'local appdata with spaces'),runtime=path.join(local,'OpenAI','Codex','bin');
 for(const [name,seconds] of [['old',1000],['new',2000]]){const dir=path.join(runtime,name);fs.mkdirSync(dir,{recursive:true});const exe=path.join(dir,'codex.exe');fs.writeFileSync(exe,'synthetic, never executed');fs.utimesSync(exe,seconds,seconds);}
 fs.mkdirSync(path.join(runtime,'directory','codex.exe'),{recursive:true});
 const result=probe(root,imports+"process.env.OPENAI_API_KEY='synthetic-do-not-pass';process.env.CODEX_API_KEY='synthetic-do-not-pass';let calls=0;cp.spawnSync=(exe,args,options)=>{calls++;assert.deepEqual(args,['login','status']);assert.equal(options.env.OPENAI_API_KEY,undefined);assert.equal(options.env.CODEX_API_KEY,undefined);assert.ok(exe.endsWith('new'+(process.platform==='win32'?'\\\\':'/')+'codex.exe'));return {status:0,stdout:'Logged in using ChatGPT',stderr:''};};syncBuiltinESMExports();const m=await import(process.argv[1]);assert.equal(calls,0);const status=m.authStatus();assert.equal(status.connected,true);assert.equal(calls,1);console.log(JSON.stringify({status,calls}));",{local});
 assert.equal(result.calls,1);
});
test('I03 managed inference stays denied without resolving a local Codex installation',t=>{
 const root=owned(t);
 const result=probe(root,imports+"fs.readdirSync=()=>{throw new Error('must not inspect local install')};const m=await import(process.argv[1]);assert.equal(m.authStatus().connected,false);await assert.rejects(m.infer('synthetic',{}),/ACCESS_MANAGED_INFERENCE_NOT_CONNECTED/);console.log(JSON.stringify({denied:true}));",{managed:true});
 assert.equal(result.denied,true);
});
test('I03 absent local inference fails explicitly before creating a job',t=>{
 const root=owned(t);
 const result=probe(root,imports+"const m=await import(process.argv[1]);await assert.rejects(m.infer('synthetic',{}),/CODEX_UNAVAILABLE/);console.log(JSON.stringify({denied:true}));");
 assert.equal(result.denied,true);
});
