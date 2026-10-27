import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import{createHash}from'node:crypto';import{recoverInterruptedU2Merge}from'../scripts/merge-into-u2.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
for(const variant of ['complete','missing','corrupt','manifest-missing','traversal','wrong-target','legacy'])test(`merge recovery fails closed: ${variant}`,t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'afh-recovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const target=path.join(root,'target'),backup=target+'.afh-merge-backup';fs.mkdirSync(target);fs.mkdirSync(path.join(backup,'files'),{recursive:true});fs.writeFileSync(path.join(target,'old.txt'),'new');fs.writeFileSync(path.join(target,'added.txt'),'added');fs.writeFileSync(path.join(backup,'files','old.txt'),'original');
 const manifest={version:2,targetRoot:target,entries:[{rel:'old.txt',existed:true,mode:0o600,size:8,sha256:hash('original')},{rel:'added.txt',existed:false,mode:0o600,size:null,sha256:null}]};
 if(variant==='traversal')manifest.entries[0].rel='../escape.txt';if(variant==='wrong-target')manifest.targetRoot=root;
 if(variant!=='manifest-missing')fs.writeFileSync(path.join(backup,'backup-manifest.json'),JSON.stringify(variant==='legacy'?manifest.entries:manifest));
 if(variant==='missing')fs.unlinkSync(path.join(backup,'files','old.txt'));if(variant==='corrupt')fs.writeFileSync(path.join(backup,'files','old.txt'),'tampered');
 if(variant==='complete'){assert.equal(recoverInterruptedU2Merge(target),true);assert.equal(fs.readFileSync(path.join(target,'old.txt'),'utf8'),'original');assert.equal(fs.existsSync(path.join(target,'added.txt')),false);assert.equal(fs.existsSync(backup),false);assert.equal(recoverInterruptedU2Merge(target),false);}
 else{assert.throws(()=>recoverInterruptedU2Merge(target),{code:'INVALID_BACKUP'});assert.equal(fs.readFileSync(path.join(target,'old.txt'),'utf8'),'new');assert.equal(fs.readFileSync(path.join(target,'added.txt'),'utf8'),'added');assert.ok(fs.existsSync(backup));}
});
