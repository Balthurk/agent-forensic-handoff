import fs from 'node:fs';
import path from 'node:path';
import {acquireStoreLease} from '../agent-forensic-handoff/src/common-store.js';

// Native validation is for external backup/export destinations. Acquiring a
// common-store lease additionally requires the explicit PostgreSQL binding.
export function plainPath(value) {
  const root=path.resolve(value);
  for(let p=root;;p=path.dirname(p)) {
    if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw new Error('RECOVERY_LINK_PATH');
    if(path.dirname(p)===p)break;
  }
  return root;
}
const sessions=new Map();
const canonical=root=>process.platform==='win32'?root.toLowerCase():root;
export function useStore(root) {
  root=plainPath(root);const key=canonical(root),existing=sessions.get(key);
  if(existing){existing.lease.assertAlive();return existing;}
  const lease=acquireStoreLease(root),session={token:lease.token,lease,
    release(){try{lease.release();}finally{sessions.delete(key);}},
  };
  sessions.set(key,session);return session;
}
export function exclusiveStore(root,{ownSession=false}={}) {
  root=plainPath(root);
  const lease=acquireStoreLease(root,{mode:'exclusive',ownLease:ownSession?sessions.get(canonical(root))?.lease:undefined});
  return ()=>lease.release();
}
// The bridge drains relational and object owners before releasing its leases.
// Abrupt exit closes the exact server connections; no PID/TTL stealing.
