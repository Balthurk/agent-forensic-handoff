import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

// A sidecar is deliberately outside the data tree. No lease timeout can turn a
// slow living writer into an allegedly quiescent store. PID reuse fails busy.
export function plainPath(value) {
  const root=path.resolve(value);
  for(let p=root;;p=path.dirname(p)) {
    if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw new Error('RECOVERY_LINK_PATH');
    if(path.dirname(p)===p)break;
  }
  return root;
}
export function guardFile(root) {root=plainPath(root);return path.join(path.dirname(root),'.'+path.basename(root)+'.orbita-access.sqlite');}
function alive(pid) {try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}
function change(root,fn) {
  const file=plainPath(guardFile(root));fs.mkdirSync(path.dirname(file),{recursive:true});
  if(fs.existsSync(file)&&fs.statSync(file).nlink!==1)throw new Error('RECOVERY_ALIASED_GUARD');
  const db=new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS owners(token TEXT PRIMARY KEY,pid INTEGER NOT NULL,mode TEXT NOT NULL); BEGIN IMMEDIATE;');
    for(const o of db.prepare('SELECT * FROM owners').all())if(!alive(o.pid))db.prepare('DELETE FROM owners WHERE token=?').run(o.token);
    const result=fn(db);db.exec('COMMIT');return result;
  }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}finally{db.close();}
}
const sessions=new Map();
function release(root,token){change(root,db=>db.prepare('DELETE FROM owners WHERE token=?').run(token));}
export function useStore(root) {
  root=plainPath(root);if(sessions.has(root))return sessions.get(root);
  const token=randomUUID();change(root,db=>{
    if(db.prepare("SELECT 1 FROM owners WHERE mode='exclusive'").get())throw new Error('RECOVERY_STORE_LOCKED');
    db.prepare('INSERT INTO owners VALUES(?,?,?)').run(token,process.pid,'shared');
  });
  const session={token,release(){release(root,token);sessions.delete(root);}};sessions.set(root,session);return session;
}
export function exclusiveStore(root,{ownSession=false}={}) {
  root=plainPath(root);const token=randomUUID(),allowed=ownSession?sessions.get(root)?.token:null;
  change(root,db=>{
    const others=db.prepare('SELECT * FROM owners').all().filter(o=>o.token!==allowed);
    if(others.length)throw new Error('RECOVERY_STORE_BUSY: close other processes using this store');
    db.prepare('INSERT INTO owners VALUES(?,?,?)').run(token,process.pid,'exclusive');
  });
  return ()=>release(root,token);
}
process.once('exit',()=>{for(const [root,s] of sessions)try{release(root,s.token);}catch{}});
