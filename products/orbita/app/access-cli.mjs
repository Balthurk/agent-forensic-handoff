import fs from 'node:fs';
import path from 'node:path';
import {AccessStore,demand} from './access-store.mjs';

// Credentials arrive on stdin, never in command-line arguments or output.
const [op,root]=process.argv.slice(2);demand(op==='init'&&root,'Usage: node access-cli.mjs init ROOT < private-input.json');
demand(!fs.existsSync(path.join(path.resolve(root),'access.sqlite')),'ACCESS_ALREADY_INITIALIZED');
const input=JSON.parse(fs.readFileSync(0,'utf8')),store=new AccessStore(root,{create:true});
try{const user=store.createAccount(input.username,input.password,{admin:true});console.log(JSON.stringify({initialized:true,root:store.root,user:{id:user.id,name:user.name},version:'orbita.access.v1'}));}finally{store.close();}
