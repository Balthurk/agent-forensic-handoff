import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomBytes,randomUUID,scryptSync,timingSafeEqual} from 'node:crypto';
import {plainPath} from './store-access.mjs';

export const ACCESS_VERSION='orbita.access.v1';
export const hash=value=>createHash('sha256').update(value).digest('hex');
export function demand(ok,code,status=400){if(!ok){const e=new Error(code);e.status=status;throw e;}}
const token=()=>randomBytes(32).toString('base64url');
const instant=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().replace('.000Z','Z')===value.replace('.000Z','Z');
const key=(password,salt)=>scryptSync(password,salt,32,{N:131072,r:8,p:1,maxmem:256*1024**2});
const username=value=>{demand(typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/.test(value),'ACCESS_USERNAME');return value.toLowerCase();};
export const ROLES=['reader','editor','owner'];

// This control store is outside every memory/export. Restoring evidence must
// never roll back accounts, membership revocations or purge tombstones.
export class AccessStore{
 constructor(root,{create=false,clock=()=>Date.now()}={}){
  this.root=plainPath(root);this.clock=clock;const file=path.join(this.root,'access.sqlite');
  demand(create||fs.existsSync(file),'ACCESS_NOT_INITIALIZED',503);
  fs.mkdirSync(this.root,{recursive:true});plainPath(file);
  if(fs.existsSync(file))demand(fs.lstatSync(file).isFile()&&fs.statSync(file).nlink===1,'ACCESS_CONTROL_ALIAS');
  this.db=new DatabaseSync(file);this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
   CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT UNIQUE,salt TEXT,password TEXT,enabled INTEGER,admin INTEGER,epoch INTEGER);
   CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user TEXT,epoch INTEGER,expires INTEGER,last_seen INTEGER,kind TEXT,workspace TEXT);
   CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,revision INTEGER,payload TEXT);
   CREATE TABLE IF NOT EXISTS members(workspace TEXT,user TEXT,role TEXT,revision INTEGER,PRIMARY KEY(workspace,user));
   CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY,at TEXT,actor TEXT,action TEXT,workspace TEXT,detail TEXT);
   CREATE TABLE IF NOT EXISTS attempts(name TEXT PRIMARY KEY,count INTEGER,until_at INTEGER);
   CREATE TABLE IF NOT EXISTS archives(id TEXT PRIMARY KEY,workspace TEXT,payload TEXT);
   CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,workspace TEXT,payload TEXT);`);
 }
 close(){this.db.close();}
 tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 now(){return new Date(this.clock()).toISOString();}
 audit(actor,action,workspace=null,detail={}){this.db.prepare('INSERT INTO audit(at,actor,action,workspace,detail) VALUES(?,?,?,?,?)').run(this.now(),actor,action,workspace,JSON.stringify(detail));}
 createAccount(name,password,{admin=false,actor='local-operator'}={}){
  name=username(name);demand(typeof password==='string'&&password.length>=16&&password.length<=1024,'ACCESS_PASSWORD_16_CHARACTERS');
  const salt=token(),id=randomUUID(),derived=key(password,salt).toString('hex');
  this.tx(()=>{demand(!this.db.prepare('SELECT 1 FROM users WHERE name=?').get(name),'ACCESS_ACCOUNT_EXISTS',409);this.db.prepare('INSERT INTO users VALUES(?,?,?,?,1,?,1)').run(id,name,salt,derived,admin?1:0);this.audit(actor,'account_created',null,{id});});return {id,name,admin};
 }
 user(id){const u=this.db.prepare('SELECT id,name,enabled,admin,epoch FROM users WHERE id=?').get(id);demand(u?.enabled===1,'ACCESS_SESSION_REQUIRED',401);return u;}
 login(name,password){
  name=username(name);demand(typeof password==='string'&&password.length<=1024,'ACCESS_LOGIN_FAILED',401);const now=this.clock();
  const attempt=this.db.prepare('SELECT * FROM attempts WHERE name=?').get(hash(name));demand(!attempt||attempt.until_at<=now||attempt.count<5,'ACCESS_LOGIN_RATE_LIMIT',429);
  const u=this.db.prepare('SELECT * FROM users WHERE name=?').get(name),derived=key(password,u?.salt||'orbita-unknown-account-fixed-salt');
  const ok=!!u&&u.enabled===1&&timingSafeEqual(derived,Buffer.from(u.password,'hex'));
  if(!ok){this.db.prepare('INSERT OR REPLACE INTO attempts VALUES(?,?,?)').run(hash(name),attempt&&attempt.until_at>now?attempt.count+1:1,attempt&&attempt.until_at>now?attempt.until_at:now+300000);this.audit(null,'login_failed');demand(false,'ACCESS_LOGIN_FAILED',401);}
  this.db.prepare('DELETE FROM attempts WHERE name=?').run(hash(name));return this.issue(u.id,{kind:'browser',expires:now+8*3600000});
 }
 issue(user,{kind='agent',workspace=null,expires=this.clock()+3600000}={}){
  const u=this.user(user);demand(Number.isSafeInteger(expires)&&expires>this.clock()&&expires<=this.clock()+8*3600000,'ACCESS_TOKEN_EXPIRY');
  if(kind==='agent'){demand(workspace,'ACCESS_TOKEN_SCOPE');this.authorizeUser(user,workspace,'reader');demand(expires<=this.clock()+3600000,'ACCESS_TOKEN_EXPIRY');}
  const secret=token();this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?)').run(hash(secret),user,u.epoch,expires,this.clock(),kind,workspace);
  this.audit(user,'session_created',workspace,{kind});return {token:secret,expiresAt:new Date(expires).toISOString(),csrf:hash('csrf:'+secret)};
 }
 session(secret,{touch=true}={}){
  demand(typeof secret==='string'&&/^[A-Za-z0-9_-]{43}$/.test(secret),'ACCESS_SESSION_REQUIRED',401);
  const s=this.db.prepare('SELECT * FROM sessions WHERE hash=?').get(hash(secret)),now=this.clock();
  demand(s&&s.expires>now&&(s.kind!=='browser'||s.last_seen+3600000>now),'ACCESS_SESSION_REQUIRED',401);const u=this.user(s.user);demand(s.epoch===u.epoch,'ACCESS_SESSION_REQUIRED',401);
  if(touch)this.db.prepare('UPDATE sessions SET last_seen=? WHERE hash=?').run(now,s.hash);
  return {...s,user:u.id,name:u.name,admin:u.admin===1,csrf:hash('csrf:'+secret)};
 }
 logout(secret){const s=this.session(secret);this.db.prepare('DELETE FROM sessions WHERE hash=?').run(s.hash);this.audit(s.user,'logout');}
 select(secret,id){const s=this.session(secret);demand(s.kind==='browser','ACCESS_AGENT_SCOPE_FIXED',403);this.authorizeUser(s.user,id,'reader');this.db.prepare('UPDATE sessions SET workspace=? WHERE hash=?').run(id,s.hash);}
 validatePolicy(input){
  demand(input&&typeof input==='object'&&!Array.isArray(input),'ACCESS_POLICY');
  const {basis,purpose,rightsUntil,retainUntil}=input;
  for(const [k,v] of Object.entries({basis,purpose}))demand(typeof v==='string'&&v.trim().length>=8&&v.length<=1000,'ACCESS_POLICY_'+k.toUpperCase());
  demand(instant(rightsUntil)&&instant(retainUntil)&&Date.parse(rightsUntil)>this.clock()&&Date.parse(retainUntil)>this.clock(),'ACCESS_POLICY_FUTURE_DATES');
  return {basis:basis.trim(),purpose:purpose.trim(),rightsUntil,retainUntil,authority:'owner_declaration_not_legal_or_factual_certification'};
 }
 createWorkspace(user,{name,policy}){
  this.user(user);demand(typeof name==='string'&&name.trim()&&name.length<=120,'ACCESS_WORKSPACE_NAME');policy=this.validatePolicy(policy);
  const id='ws-'+randomUUID(),w={id,name:name.trim(),owner:user,revision:1,status:'active',policy,legalHold:false,externalCopies:[],createdAt:this.now()};
  const dir=this.workspaceRoot(id);demand(!fs.existsSync(dir),'ACCESS_WORKSPACE_EXISTS');fs.mkdirSync(path.join(dir,'data'),{recursive:true});fs.writeFileSync(path.join(dir,'data','library.json'),'[]',{flag:'wx'});
  this.tx(()=>{this.db.prepare('INSERT INTO workspaces VALUES(?,?,?)').run(id,1,JSON.stringify(w));this.db.prepare('INSERT INTO members VALUES(?,?,?,1)').run(id,user,'owner');this.audit(user,'workspace_created',id);});return w;
 }
 workspaceRoot(id){demand(typeof id==='string'&&/^ws-[a-f0-9-]{36}$/.test(id),'ACCESS_WORKSPACE_ID');const parent=plainPath(path.join(this.root,'spaces')),dest=plainPath(path.join(parent,id));demand(path.dirname(dest)===parent,'ACCESS_PATH_ESCAPE');return dest;}
 workspace(id){this.workspaceRoot(id);const row=this.db.prepare('SELECT payload FROM workspaces WHERE id=?').get(id);demand(row,'ACCESS_DENIED',403);return JSON.parse(row.payload);}
 save(w,action,actor,detail={}){const revision=w.revision,next={...w,revision:revision+1};this.tx(()=>{demand(this.db.prepare('UPDATE workspaces SET payload=?,revision=? WHERE id=? AND revision=?').run(JSON.stringify(next),next.revision,w.id,revision).changes===1,'ACCESS_REVISION_CONFLICT',409);this.audit(actor,action,w.id,detail);});return next;}
 active(w){demand(w.status==='active','ACCESS_WORKSPACE_PAUSED',403);demand(Date.parse(w.policy.rightsUntil)>this.clock(),'ACCESS_SOURCE_RIGHTS_EXPIRED',403);demand(Date.parse(w.policy.retainUntil)>this.clock(),'ACCESS_RETENTION_EXPIRED',403);}
 authorizeUser(user,id,role='reader',{maintenance=false}={}){
  this.user(user);const w=this.workspace(id),m=this.db.prepare('SELECT * FROM members WHERE workspace=? AND user=?').get(id,user);
  demand(m&&ROLES.indexOf(m.role)>=ROLES.indexOf(role)&&w.status!=='purged','ACCESS_DENIED',403);if(!maintenance)this.active(w);
  return {workspace:w,role:m.role,membershipRevision:m.revision,user};
 }
 authorize(secret,id,role='reader',options){const s=this.session(secret);demand(s.kind!=='agent'||s.workspace===id,'ACCESS_DENIED',403);return {...this.authorizeUser(s.user,id,role,options),session:s};}
 fence(secret,access,role='reader'){
  const current=this.authorize(secret,access.workspace.id,role);demand(current.workspace.revision===access.workspace.revision&&current.membershipRevision===access.membershipRevision,'ACCESS_CHANGED_DURING_REQUEST',409);return current;
 }
 list(user){this.user(user);return this.db.prepare('SELECT w.payload,m.role FROM workspaces w JOIN members m ON m.workspace=w.id WHERE m.user=?').all(user).map(r=>{const w=JSON.parse(r.payload);let available=true,reason=null;try{this.active(w);}catch(e){available=false;reason=e.message;}return {...w,role:r.role,available,reason};});}
 members(user,id){this.authorizeUser(user,id,'owner',{maintenance:true});return this.db.prepare('SELECT u.id,u.name,m.role,m.revision FROM members m JOIN users u ON u.id=m.user WHERE m.workspace=?').all(id);}
 grant(user,id,name,role){const w=this.authorizeUser(user,id,'owner',{maintenance:true}).workspace;demand(['reader','editor'].includes(role),'ACCESS_ROLE');const target=this.db.prepare('SELECT id FROM users WHERE name=? AND enabled=1').get(username(name));demand(target&&target.id!==w.owner,'ACCESS_MEMBER');
  this.tx(()=>{this.db.prepare('INSERT INTO members VALUES(?,?,?,1) ON CONFLICT(workspace,user) DO UPDATE SET role=excluded.role,revision=members.revision+1').run(id,target.id,role);this.audit(user,'membership_granted',id,{user:target.id,role});});return {id:target.id,role};
 }
 revoke(user,id,target){const w=this.authorizeUser(user,id,'owner',{maintenance:true}).workspace;demand(target!==w.owner,'ACCESS_OWNER_CANNOT_BE_REVOKED');this.tx(()=>{this.db.prepare('DELETE FROM members WHERE workspace=? AND user=?').run(id,target);this.db.prepare('DELETE FROM sessions WHERE user=? AND workspace=?').run(target,id);this.audit(user,'membership_revoked',id,{user:target});});return {revoked:true};}
 policy(user,id,input){let w=this.authorizeUser(user,id,'owner',{maintenance:true}).workspace;demand(w.status==='active'||w.status==='suspended','ACCESS_MAINTENANCE_PENDING',409);demand(typeof input.reason==='string'&&input.reason.trim().length>=8,'ACCESS_REASON');
  if(input.policy)w.policy=this.validatePolicy(input.policy);
  if(input.legalHold!==undefined){demand(typeof input.legalHold==='boolean','ACCESS_HOLD');w.legalHold=input.legalHold;}
  if(input.suspended!==undefined){demand(typeof input.suspended==='boolean','ACCESS_SUSPENDED');w.status=input.suspended?'suspended':'active';}
  return this.save(w,'policy_changed',user,{reason:input.reason.slice(0,500)});
 }
 externalCopy(user,id,label){let w=this.authorizeUser(user,id,'owner',{maintenance:true}).workspace;demand(typeof label==='string'&&label.length>0&&label.length<=200,'ACCESS_COPY_LABEL');w.externalCopies.push({id:randomUUID(),label,state:'outstanding',at:this.now()});return this.save(w,'external_copy_registered',user);}
 acknowledgeCopy(user,id,copyId,reason){let w=this.authorizeUser(user,id,'owner',{maintenance:true}).workspace;demand(typeof reason==='string'&&reason.trim().length>=8,'ACCESS_REASON');const c=w.externalCopies.find(c=>c.id===copyId);demand(c,'ACCESS_COPY_NOT_FOUND');c.state='owner_declared_deleted';c.at=this.now();return this.save(w,'external_copy_deletion_declared',user,{id:copyId});}
 deleteAccount(actor,id){
  const a=this.user(actor);demand(a.admin===1||actor===id,'ACCESS_DENIED',403);this.user(id);
  demand(!this.list(id).some(w=>w.owner===id&&w.status!=='purged'),'ACCESS_OWNED_WORKSPACES_REMAIN',409);
  demand(!this.db.prepare('SELECT admin FROM users WHERE id=?').get(id).admin||this.db.prepare('SELECT count(*) n FROM users WHERE admin=1 AND enabled=1').get().n>1,'ACCESS_LAST_ADMIN',409);
  this.tx(()=>{this.db.prepare('DELETE FROM sessions WHERE user=?').run(id);this.db.prepare('DELETE FROM members WHERE user=?').run(id);this.db.prepare('UPDATE users SET name=NULL,password=NULL,salt=NULL,enabled=0,epoch=epoch+1 WHERE id=?').run(id);this.audit(actor,'account_erased',null,{id});});return {erased:true,pseudonymousAuditRetained:true};
 }
}
