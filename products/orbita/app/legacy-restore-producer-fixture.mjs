// Disposable qualification inputs. No provider or real user data is used.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,scryptSync,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
const [mode,oracle,root,payloadFile]=process.argv.slice(2),temporary=path.resolve(process.env.TEMP);
const within=p=>assert.ok(path.resolve(p).startsWith(temporary+path.sep));within(root);
const password='synthetic-v1-restore-password-only',sha=bytes=>createHash('sha256').update(bytes).digest('hex');
if(mode==='original'){
 assert.equal(fs.existsSync(root),false);fs.mkdirSync(root);const source=path.join(root,'source');fs.mkdirSync(source);
 fs.writeFileSync(path.join(source,'library.json'),'[]');fs.mkdirSync(path.join(source,'empty'));fs.mkdirSync(path.join(source,'embedding-cache'));
 fs.writeFileSync(path.join(source,'ficticio.txt'),'Literal ficticio ñ 😀\n');
 const old=fs.readFileSync(path.join(oracle,'app/embedding-cache.mjs'),'utf8'),schema=old.match(/db\.exec\('([^']+)'\)/)[1];
 const db=new DatabaseSync(path.join(source,'embedding-cache/embeddings.sqlite'));
 try{db.exec(schema);db.prepare('INSERT INTO vectors VALUES(?,?,?,?,?)').run('original','hash','literal ñ😀','[1,0]','original-vector-hash');}finally{db.close();}
 const {createBackup}=await import(pathToFileURL(path.join(oracle,'app/recovery.mjs')));
 const receipt=await createBackup({source,archive:path.join(root,'archive.orbita'),password,scratchRoot:root});
 const bytes=fs.readFileSync(receipt.archive),header=bytes.subarray(0,45),key=scryptSync(password,header.subarray(17,33),32,{N:32768,r:8,p:1,maxmem:64*1024**2});
 const d=createDecipheriv('aes-256-gcm',key,header.subarray(33));d.setAAD(header);d.setAuthTag(bytes.subarray(-16));
 fs.writeFileSync(path.join(root,'payload.bin'),Buffer.concat([d.update(bytes.subarray(45,-16)),d.final()]));key.fill(0);
 process.stdout.write(JSON.stringify({receipt,sqliteSha256:sha(fs.readFileSync(path.join(source,'embedding-cache/embeddings.sqlite'))),writerSchemaSha256:sha(Buffer.from(schema))}));
}else if(mode==='encrypt'){
 within(payloadFile);assert.equal(fs.existsSync(root),false);
 const salt=randomBytes(16),nonce=randomBytes(12),header=Buffer.concat([Buffer.from('ORBITA-BACKUP-01\0'),salt,nonce]);
 const key=scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024**2}),c=createCipheriv('aes-256-gcm',key,nonce);c.setAAD(header);
 const encrypted=Buffer.concat([header,c.update(fs.readFileSync(payloadFile)),c.final(),c.getAuthTag()]);key.fill(0);
 fs.writeFileSync(root,encrypted,{flag:'wx'});process.stdout.write(JSON.stringify({archiveSha256:sha(encrypted)}));
}else throw new Error('Unknown fixture action');
