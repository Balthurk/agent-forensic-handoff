// Passwords arrive through stdin, never command-line flags or receipt files.
import fs from 'node:fs';
import {createBackup,restoreBackup,restoreState,activateRestore} from './recovery.mjs';
try {
  const raw=fs.readFileSync(0,'utf8');if(Buffer.byteLength(raw)>16384)throw new Error('RECOVERY_REQUEST_BUDGET');
  const {op,...input}=JSON.parse(raw);let result;
  if(op==='backup')result=await createBackup(input);
  else if(op==='restore')result=await restoreBackup(input);
  else if(op==='status')result=restoreState(input.root);
  else if(op==='activate')result=activateRestore(input.root,input);
  else throw new Error('RECOVERY_UNKNOWN_OPERATION');
  process.stdout.write(JSON.stringify({ok:true,result})+'\n');
}catch(e){process.stdout.write(JSON.stringify({ok:false,error:e.message})+'\n');process.exitCode=1;}
