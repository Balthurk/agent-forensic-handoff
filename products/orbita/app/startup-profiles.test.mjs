import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';

const APP=path.dirname(fileURLToPath(import.meta.url)),shell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const profiles=JSON.parse(fs.readFileSync(process.env.ORBITA_STARTUP_TEST_PROFILES,'utf8'));
const read=name=>JSON.parse(fs.readFileSync(profiles[name],'utf8'));
const root=name=>read(name).bindings[0].root;
const inputEnv=name=>({...process.env,ORBITA_POSTGRES_CONFIG:profiles[name]});
function probe(name,mode='Personal',config=profiles[name],data=root(name),extra={}){
 return spawnSync(shell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(APP,'START.ps1'),'-Mode',mode,'-Data',data,'-PostgresConfig',config,'-Python',process.env.ORBITA_POSTGRES_PYTHON,'-Node',process.execPath,'-ModelHome',process.env.AFH_MODEL_HOME,'-CheckOnly'],{env:{...inputEnv(name),...extra},encoding:'utf8',windowsHide:true,timeout:45000});
}
function ready(result,mode,kind){assert.equal(result.status,0,result.stderr);const value=JSON.parse(result.stdout);assert.equal(value.status,'READY');assert.equal(value.mode,mode);assert.equal(value.health.workspaceKind,kind);assert.equal(value.health.readOnly,true);return value;}
function rejected(result,pattern){assert.notEqual(result.status,0);assert.match(result.stderr,pattern);assert.ok(!result.stdout.includes('"status":"READY"'));}
function profile(value){const file=path.join(process.env.ORBITA_STARTUP_TEST_PRIVATE,'profile-'+randomBytes(6).toString('hex')+'.json');fs.writeFileSync(file,JSON.stringify(value),{flag:'wx'});return file;}
function manifest(name){
 const code="import{DatabaseSync,closeCommonStore}from'../agent-forensic-handoff/src/common-store.js';const db=new DatabaseSync(process.argv[1],{family:'access',readOnly:true});try{console.log(JSON.stringify(db.logicalManifest()));}finally{db.close();closeCommonStore();}";
 const result=spawnSync(process.execPath,['--input-type=module','-e',code,path.join(root(name),'access.pgstore')],{cwd:APP,env:inputEnv(name),encoding:'utf8',windowsHide:true,timeout:30000});
 assert.equal(result.status,0,result.stderr);return result.stdout;
}
before(()=>{
 const result=spawnSync(process.execPath,[path.join(APP,'access-cli.mjs'),'init',root('control')],{cwd:APP,env:inputEnv('control'),input:JSON.stringify({username:'startup_fixture',password:randomBytes(32).toString('hex')}),encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(result.status,0,result.stderr);
});
test('personal profile starts only its admitted personal workspace',()=>ready(probe('personal'),'Personal','personal'));
test('managed probe preserves every control row',()=>{const prior=manifest('control');ready(probe('control','Managed'),'Managed','control');assert.equal(manifest('control'),prior);});
test('control cannot be launched as a personal server',()=>rejected(probe('control'),/START_WORKSPACE_KIND/));
test('personal cannot be launched as a managed gateway',()=>rejected(probe('personal','Managed'),/START_WORKSPACE_KIND/));
test('an uninitialized control is not created by startup',()=>rejected(probe('emptyControl','Managed'),/ORBITA_PG_/));
test('a profile carrying unrelated bindings is rejected before startup',()=>{const value=read('personal');value.bindings.push(read('control').bindings[0]);rejected(probe('personal','Personal',profile(value)),/START_SINGLE_ROOT_PROFILE_REQUIRED/);});
test('operator credentials are not runtime profiles',()=>{const value=read('personal');value.user='orbita_admin';value.password='SECRET_CANARY_NEVER_REPORT';const result=probe('personal','Personal',profile(value));rejected(result,/START_SINGLE_ROOT_PROFILE_REQUIRED/);assert.ok(!JSON.stringify(result).includes(value.password));});
test('a different virtual root cannot be substituted',()=>rejected(probe('personal','Personal',profiles.personal,root('control')),/START_SINGLE_ROOT_PROFILE_REQUIRED/));
test('mode is explicit despite inherited worker and access variables',()=>ready(probe('personal','personal',profiles.personal,root('personal'),{AFH_MANAGED:'1',AFH_PRIVATE_TOKEN:'unusable',AFH_ACCESS_URL:'http://127.0.0.1:1'}),'Personal','personal'));
test('inline and file credentials are not combined',()=>rejected(probe('personal','Personal',profiles.personal,root('personal'),{ORBITA_POSTGRES_BINDING:'{}'}),/START_REQUIRES_FILE_CONFIGURATION/));
test('published F35 control passes startup without modifying its historical rows',()=>{const prior=manifest('realF35');ready(probe('realF35','Managed'),'Managed','control');assert.equal(manifest('realF35'),prior);});
test('published F36 control passes startup without modifying its historical rows',()=>{const prior=manifest('realF36');ready(probe('realF36','Managed'),'Managed','control');assert.equal(manifest('realF36'),prior);});
