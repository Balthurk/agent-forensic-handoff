// Qualification only. The original I05 writer creates the real v1 format.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createDecipheriv,createCipheriv,scryptSync,createHash} from 'node:crypto';
const [oracle,root]=process.argv.slice(2),temporary=path.resolve(process.env.TEMP);
assert.ok(path.resolve(root).startsWith(temporary+path.sep));
assert.match(path.basename(root),/^legacy-cipher-[a-f0-9-]{36}$/);assert.equal(fs.existsSync(root),false);
const {createBackup}=await import(pathToFileURL(path.join(oracle,'app/recovery.mjs')));
const password='synthetic-legacy-cipher-password-only';
fs.mkdirSync(root);const source=path.join(root,'source');fs.mkdirSync(source);
fs.writeFileSync(path.join(source,'library.json'),'[]');fs.mkdirSync(path.join(source,'opaque'));
fs.writeFileSync(path.join(source,'opaque','multi-block.bin'),Buffer.alloc(2*1024**2+37,213));
const archive=path.join(root,'archive.orbita');
const receipt=await createBackup({source,archive,password,scratchRoot:root});
const cipher=fs.readFileSync(archive),header=cipher.subarray(0,45),key=scryptSync(password,header.subarray(17,33),32,{N:32768,r:8,p:1,maxmem:64*1024**2});
const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(33));decipher.setAAD(header);decipher.setAuthTag(cipher.subarray(-16));
const payload=Buffer.concat([decipher.update(cipher.subarray(45,-16)),decipher.final()]);
// A separate, deliberately non-frame payload proves authentication does not parse.
const opaque=Buffer.from([255,0,254,1,253,2]),other=createCipheriv('aes-256-gcm',key,header.subarray(33));other.setAAD(header);
const opaqueArchive=Buffer.concat([header,other.update(opaque),other.final(),other.getAuthTag()]);
fs.writeFileSync(path.join(root,'opaque.orbita'),opaqueArchive);key.fill(0);
const sha=value=>createHash('sha256').update(value).digest('hex');
process.stdout.write(JSON.stringify({archiveSha256:receipt.archiveSha256,payloadSha256:sha(payload),payloadBytes:payload.length,opaqueSha256:sha(opaqueArchive),opaquePayloadSha256:sha(opaque),originalWriter:true}));
