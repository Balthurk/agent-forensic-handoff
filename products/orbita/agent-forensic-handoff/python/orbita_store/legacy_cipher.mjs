// Explicit legacy import worker. Metadata is private stdin, never argv/env.
// This process authenticates bytes only; it never parses archive content.
import {createDecipheriv,scryptSync} from 'node:crypto';
const magic=Buffer.from('ORBITA-BACKUP-01\0');let key;
const demand=ok=>{if(!ok)throw new Error('invalid input');};
const write=bytes=>new Promise((resolve,reject)=>process.stdout.write(bytes,error=>error?reject(error):resolve()));
try{
 let pending=Buffer.alloc(0),length=null,metadata=null,decipher=null,seen=0;
 for await(const incoming of process.stdin){
  let body=incoming;
  if(!metadata){
   pending=Buffer.concat([pending,body]);body=Buffer.alloc(0);
   if(length===null&&pending.length>=4){length=pending.readUInt32BE();demand(length>0&&length<=8192);pending=pending.subarray(4);}
   if(length===null||pending.length<length)continue;
   metadata=JSON.parse(pending.subarray(0,length).toString('utf8'));body=pending.subarray(length);pending=Buffer.alloc(0);
   demand(JSON.stringify(Object.keys(metadata))===JSON.stringify(['password','header','tag','bytes']));
   demand(typeof metadata.password==='string'&&[...metadata.password].length>=12&&Buffer.byteLength(metadata.password)<=4096);
   const header=Buffer.from(metadata.header,'base64'),tag=Buffer.from(metadata.tag,'base64');
   demand(header.length===magic.length+28&&header.subarray(0,magic.length).equals(magic)&&tag.length===16);
   demand(Number.isSafeInteger(metadata.bytes)&&metadata.bytes>0&&metadata.bytes<=100*1024**3);
   key=scryptSync(metadata.password,header.subarray(magic.length,magic.length+16),32,{N:32768,r:8,p:1,maxmem:64*1024**2});
   metadata.password='';decipher=createDecipheriv('aes-256-gcm',key,header.subarray(-12));decipher.setAAD(header);decipher.setAuthTag(tag);
  }
  seen+=body.length;demand(seen<=metadata.bytes);
  if(body.length){const plain=decipher.update(body);if(plain.length)await write(plain);}
 }
 demand(metadata&&seen===metadata.bytes);
 const last=decipher.final();if(last.length)await write(last);
}catch{
 process.stderr.write('LEGACY_CIPHER_AUTHENTICATION_FAILED\n');process.stdin.destroy();process.exitCode=1;
}finally{key?.fill(0);process.stdout.end();}
