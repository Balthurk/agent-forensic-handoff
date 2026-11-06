// Private stdin contains one bounded runtime binding; stdout has counts only.
import path from 'node:path';
let raw=Buffer.alloc(0),close;
try{
 for await(const chunk of process.stdin){raw=Buffer.concat([raw,chunk]);if(raw.length>1024**2)throw new Error('budget');}
 const input=JSON.parse(raw.toString('utf8'));raw.fill(0);
 if(!input||typeof input.root!=='string'||!path.isAbsolute(input.root)||typeof input.python!=='string'||!path.isAbsolute(input.python))throw new Error('input');
 process.env.ORBITA_POSTGRES_BINDING=JSON.stringify(input.config);process.env.ORBITA_POSTGRES_PYTHON=input.python;delete process.env.ORBITA_POSTGRES_CONFIG;
 ({closeCommonStore:close}=await import('../agent-forensic-handoff/src/common-store.js'));
 const {validateStore}=await import('./recovery.mjs');
 const validation=await validateStore(input.root);const closure=close();
 if(closure.drained!==true)throw new Error('closure');close=null;
 process.stdout.write(JSON.stringify({status:'PASS_FRESH_APPLICATION_VALIDATION',validation,closed:true}));
}catch{
 process.stderr.write('LEGACY_RESTORE_APPLICATION_VALIDATION_FAILED\n');process.exitCode=1;
}finally{if(close){try{if(close().drained!==true)process.exitCode=1;}catch{process.exitCode=1;}}}
