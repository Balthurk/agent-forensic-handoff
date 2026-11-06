import fs from 'node:fs';
import contentFiles from '../agent-forensic-handoff/src/common-files.js';
import {closeCommonStore} from '../agent-forensic-handoff/src/common-store.js';
import path from 'node:path';
import {AccessStore,demand} from './access-store.mjs';

// Credentials arrive on stdin, never in command-line arguments or output.
let store;
try{
 const [op,root]=process.argv.slice(2);demand(op==='init'&&root,'Usage: node access-cli.mjs init ROOT < private-input.json');
 demand(!contentFiles.existsSync(path.join(path.resolve(root),'access.pgstore')),'ACCESS_ALREADY_INITIALIZED');
 const input=JSON.parse(fs.readFileSync(0,'utf8'));store=new AccessStore(root,{create:true});
 const user=store.createAccount(input.username,input.password,{admin:true});console.log(JSON.stringify({initialized:true,root:store.root,user:{id:user.id,name:user.name},version:'orbita.access.v1'}));
}finally{try{store?.close();}finally{closeCommonStore();}}
