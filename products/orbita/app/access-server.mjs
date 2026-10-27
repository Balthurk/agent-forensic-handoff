import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {AccessStore,demand,hash,ACCESS_VERSION} from './access-store.mjs';
import {requestRole,assertManagedRequest,managedCapabilities} from './access-policy.mjs';
import {Workers} from './access-workers.mjs';
import {responseLease} from './worker-activity.mjs';
import {Lifecycle} from './access-lifecycle.mjs';
import {plainPath} from './store-access.mjs';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const security={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'"};
function json(res,status,value,headers={}){res.writeHead(status,{...security,'content-type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(value));}
async function body(req){let n=0,chunks=[];for await(const b of req){n+=b.length;demand(n<=64*1024**2,'ACCESS_REQUEST_TOO_LARGE',413);chunks.push(b);}try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');demand(value&&typeof value==='object'&&!Array.isArray(value),'ACCESS_JSON_OBJECT');return value;}catch(e){demand(false,e.message.startsWith('ACCESS_')?e.message:'ACCESS_JSON_INVALID');}}
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};

export function createAccessServer({root,port=4492,clock}={}){
 const store=new AccessStore(root,{clock}),workers=new Workers(store),lifecycle=new Lifecycle(store,id=>workers.stop(id));
 const lock=plainPath(path.join(store.root,'service.lock')),lockId=randomUUID();
 if(fs.existsSync(lock)){const old=JSON.parse(fs.readFileSync(lock,'utf8'));demand(Number.isInteger(old.pid)&&!alive(old.pid),'ACCESS_SERVICE_ALREADY_RUNNING',409);fs.unlinkSync(lock);}
 fs.writeFileSync(lock,JSON.stringify({pid:process.pid,id:lockId}),{flag:'wx',mode:0o600});
 let actualPort=port,closed=false,closing=null,storeClosed=false,loginWindow={at:0,count:0};const origins=()=>['http://127.0.0.1:'+actualPort,'http://localhost:'+actualPort];
 const cookieName=()=> 'orbita_access_'+actualPort;
 function secret(req){const auth=req.headers.authorization;const cookies=String(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(cookieName()+'='));demand(cookies.length<=1&&!(auth&&cookies.length),'ACCESS_CREDENTIAL_AMBIGUOUS',401);if(auth){demand(/^Bearer [A-Za-z0-9_-]{43}$/.test(auth),'ACCESS_SESSION_REQUIRED',401);return auth.slice(7);}return cookies[0]?.slice(cookieName().length+1);}
 function mutation(req,session){
  demand(req.headers['content-type']?.split(';')[0]==='application/json','ACCESS_JSON_REQUIRED',415);
  if(!req.headers.authorization){demand(origins().includes(req.headers.origin),'ACCESS_ORIGIN_REQUIRED',403);demand(req.headers['x-orbita-csrf']===session.csrf,'ACCESS_CSRF_REQUIRED',403);}
 }
 const server=http.createServer(async(req,res)=>{let finishRequest=()=>{};try{
  demand(!closed&&!closing,'ACCESS_SERVICE_STOPPING',503);
  demand(origins().map(x=>new URL(x).host).includes(req.headers.host),'ACCESS_HOST',403);
  demand(!req.headers.origin||origins().includes(req.headers.origin),'ACCESS_ORIGIN',403);
  demand(!req.headers['sec-fetch-site']||['same-origin','none'].includes(req.headers['sec-fetch-site']),'ACCESS_FETCH_SITE',403);
  const u=new URL(req.url,origins()[0]),p=u.pathname;
  if(req.method==='GET'&&['/access','/access.css','/access-web.mjs','/access-session.mjs','/managed-app.mjs'].includes(p)){
   const name=p==='/access'?'access.html':p.slice(1);res.writeHead(200,{...security,'content-type':name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8'});return res.end(fs.readFileSync(path.join(ROOT,'web',name)));
  }
  if(p==='/access/api/login'&&req.method==='POST'){
   demand(origins().includes(req.headers.origin)&&req.headers['x-orbita-login']==='1','ACCESS_ORIGIN_REQUIRED',403);demand(req.headers['content-type']?.split(';')[0]==='application/json','ACCESS_JSON_REQUIRED',415);
   const now=store.clock();if(now-loginWindow.at>=60000)loginWindow={at:now,count:0};demand(++loginWindow.count<=20,'ACCESS_LOGIN_RATE_LIMIT',429);
   const b=await body(req);demand(Object.keys(b).every(k=>['username','password'].includes(k)),'ACCESS_LOGIN_FIELDS');const session=store.login(b.username,b.password);
   return json(res,200,{authenticated:true,expiresAt:session.expiresAt},{'set-cookie':`${cookieName()}=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`});
  }
  const credential=secret(req);let session;
  try{session=store.session(credential);}catch(e){if(p==='/'&&req.method==='GET'){res.writeHead(302,{...security,location:'/access'});return res.end();}throw e;}
  if(p==='/access/api/session'&&req.method==='GET'){
   const spaces=store.list(session.user).filter(w=>session.kind!=='agent'||w.id===session.workspace),selected=spaces.find(w=>w.id===session.workspace&&w.available);
   const access=selected?store.authorize(credential,selected.id,'reader'):null;
   const capabilities={...managedCapabilities(access?.role),binding:access?{workspace:selected.id,workspaceRevision:access.workspace.revision,membershipRevision:access.membershipRevision,role:access.role}:null};
   return json(res,200,{version:ACCESS_VERSION,user:{id:session.user,name:session.name,admin:session.admin},csrf:session.csrf,selected:session.workspace,spaces,capabilities,inference:'disabled_in_managed_mode',boundary:'local_application_not_windows_administrator'});
  }
  if(p.startsWith('/access/api/')){
   if(req.method==='GET'&&p==='/access/api/members'){store.authorize(credential,u.searchParams.get('id'),'owner',{maintenance:true});return json(res,200,store.members(session.user,u.searchParams.get('id')));}
   if(req.method==='GET'&&p==='/access/api/backups'){store.authorize(credential,u.searchParams.get('id'),'owner',{maintenance:true});return json(res,200,lifecycle.archives(session.user,u.searchParams.get('id')));}
   demand(req.method==='POST','ACCESS_ROUTE_NOT_ADMITTED',403);mutation(req,session);const b=await body(req);
   // Re-read after receiving a potentially slow upload, before any mutation.
   session=store.session(credential);if(session.kind==='agent')demand(!['/access/api/accounts','/access/api/account-delete','/access/api/workspaces','/access/api/select','/access/api/token'].includes(p),'ACCESS_AGENT_SCOPE_FIXED',403);let result;
   if(p==='/access/api/logout'){store.logout(credential);return json(res,200,{loggedOut:true},{'set-cookie':`${cookieName()}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`});}
   if(p==='/access/api/select'){store.select(credential,b.id);result={selected:b.id};}
   else if(p==='/access/api/accounts'){demand(session.admin,'ACCESS_DENIED',403);result=store.createAccount(b.username,b.password,{actor:session.user});}
   else if(p==='/access/api/account-delete'){result=store.deleteAccount(session.user,b.user);for(const id of [...workers.items.keys()])await workers.stop(id);}
   else if(p==='/access/api/workspaces')result=store.createWorkspace(session.user,b);
   else if(p==='/access/api/token'){store.authorize(credential,b.id,'reader');result=store.issue(session.user,{workspace:b.id});}
   else if(p==='/access/api/grant'){store.authorize(credential,b.id,'owner',{maintenance:true});result=store.grant(session.user,b.id,b.username,b.role);await workers.stop(b.id);}
   else if(p==='/access/api/revoke'){store.authorize(credential,b.id,'owner',{maintenance:true});result=store.revoke(session.user,b.id,b.user);await workers.stop(b.id);}
   else if(p==='/access/api/policy'){store.authorize(credential,b.id,'owner',{maintenance:true});result=store.policy(session.user,b.id,b);await workers.stop(b.id);}
   else if(p==='/access/api/copy'){store.authorize(credential,b.id,'owner',{maintenance:true});result=store.externalCopy(session.user,b.id,b.label);}
   else if(p==='/access/api/copy-deleted'){store.authorize(credential,b.id,'owner',{maintenance:true});result=store.acknowledgeCopy(session.user,b.id,b.copyId,b.reason);}
   else if(p==='/access/api/preview'){store.authorize(credential,b.id,'owner',{maintenance:true});result=await lifecycle.preview(session.user,b.id);}
   else if(p==='/access/api/backup'){store.authorize(credential,b.id,'owner');result=await lifecycle.backup(session.user,b.id,b.password);}
   else if(p==='/access/api/restore'){store.authorize(credential,b.id,'owner');result=await lifecycle.restore(session.user,b.id,b.backupId,b.password);}
   else if(p==='/access/api/maintenance-recover'){store.authorize(credential,b.id,'owner',{maintenance:true});result=await lifecycle.recoverMaintenance(session.user,b.id);}
   else if(p==='/access/api/purge-plan'){store.authorize(credential,b.id,'owner',{maintenance:true});result=await lifecycle.plan(session.user,b.id);}
   else if(p==='/access/api/purge-cancel'){store.authorize(credential,b.id,'owner',{maintenance:true});result=await lifecycle.cancel(session.user,b.id);}
   else if(p==='/access/api/purge'){store.authorize(credential,b.id,'owner',{maintenance:true});result=await lifecycle.purge(session.user,b.id,b.planId,b.confirmation);}
   else if(p==='/access/api/export'){
    const access=store.authorize(credential,b.id,'owner'),archive=await lifecycle.archive(session.user,b.id,b.backupId);store.fence(credential,access,'owner');
    store.externalCopy(session.user,b.id,'Exportación '+b.backupId);const bytes=fs.readFileSync(archive.archive);store.authorize(credential,b.id,'owner');res.writeHead(200,{...security,'content-type':'application/octet-stream','content-disposition':`attachment; filename="orbita-${b.backupId}.orbita"`,'x-content-sha256':archive.sha256});return res.end(bytes);
   }else demand(false,'ACCESS_ROUTE_NOT_ADMITTED',403);
   // A self-erasure/purge can invalidate the initiating credential by design.
   if(!['/access/api/purge','/access/api/account-delete'].includes(p))store.session(credential);
   return json(res,200,result);
  }
  const id=session.workspace;demand(id,'ACCESS_SELECT_WORKSPACE',409);
  if(p.startsWith('/api/')&&session.kind==='browser')demand(req.headers['x-orbita-workspace']===id,'ACCESS_TAB_WORKSPACE_CHANGED',409);
  if(req.method==='GET'&&!p.startsWith('/api/')){
   store.authorize(credential,id,'reader');
   if(p==='/'){let html=fs.readFileSync(path.join(ROOT,'web','index.html'),'utf8');html=html.replace('<html ','<html data-access-mode="managed" ').replace(/<script type="module" src="[^"]+"><\/script>/g,'').replace('</body>','<script type="module" src="/managed-app.mjs"></script></body>');res.writeHead(200,{...security,'content-type':'text/html; charset=utf-8'});return res.end(html);}
   const file=p==='/app.js'?'web.js':p.slice(1);demand(/^[a-z0-9-]+\.(?:js|mjs|css)$/.test(file)&&fs.existsSync(path.join(ROOT,'web',file)),'ACCESS_NOT_FOUND',404);res.writeHead(200,{...security,'content-type':file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8'});return res.end(fs.readFileSync(path.join(ROOT,'web',file)));
  }
  // Protect the whole upload and response, including waits before get().
  store.authorize(credential,id,'reader');finishRequest=responseLease(res,workers.hold(id));
  let b={};if(req.method!=='GET'){mutation(req,session);b=await body(req);}
  const role=requestRole(req.method,p,b),access=store.authorize(credential,id,role);
  // Managed accounts do not silently inherit the host's Codex/Jev credentials.
  assertManagedRequest(p,b);
  const worker=await workers.get(id);store.fence(credential,access,role);
  const controller=new AbortController(),cancel=()=>{if(!res.writableEnded)controller.abort();};req.once('aborted',cancel);res.once('close',cancel);
  const timer=setTimeout(()=>controller.abort(),180000);timer.unref();
  try{
   const upstream=await fetch(`http://127.0.0.1:${worker.port}${u.pathname}${u.search}`,{method:req.method,headers:{'x-orbita-worker':worker.secret,...(req.method==='GET'?{}:{'content-type':'application/json'})},...(req.method==='GET'?{}:{body:JSON.stringify(b)}),signal:controller.signal,redirect:'error'});
   const bytes=Buffer.from(await upstream.arrayBuffer());demand(bytes.length<=64*1024**2,'ACCESS_RESPONSE_BUDGET',503);store.fence(credential,access,role);
   store.audit(session.user,'request_completed',id,{method:req.method,route:p,operation:b.op||null,status:upstream.status,accessRevision:access.workspace.revision,membershipRevision:access.membershipRevision});
   const headers={...security,'content-type':upstream.headers.get('content-type')||'application/json','x-orbita-workspace':id,'x-orbita-access-revision':String(access.workspace.revision),'x-orbita-principal':session.user};
   for(const h of ['content-disposition','x-content-sha256'])if(upstream.headers.has(h))headers[h]=upstream.headers.get(h);
   res.writeHead(upstream.status,headers);res.end(bytes);
  }finally{clearTimeout(timer);req.removeListener('aborted',cancel);res.removeListener('close',cancel);}
 }catch(e){if(!res.destroyed&&!res.writableEnded)json(res,e.status||503,{error:e.message?.startsWith('ACCESS_')?e.message:'ACCESS_OPERATION_INCOMPLETE'});}finally{finishRequest();}});
 server.on('listening',()=>actualPort=server.address().port);server.requestTimeout=190000;server.headersTimeout=15000;
 function close(){
  if(closed)return Promise.resolve();if(closing)return closing;
  const task=(async()=>{await workers.close();await new Promise(resolve=>server.close(resolve));if(!storeClosed){store.close();storeClosed=true;}if(fs.existsSync(lock)&&JSON.parse(fs.readFileSync(lock,'utf8')).id===lockId)fs.unlinkSync(lock);closed=true;})();
  closing=task;void task.catch(()=>{if(closing===task)closing=null;});return task;
 }
 return {server,store,workers,lifecycle,close};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const app=createAccessServer({root:process.env.AFH_ACCESS_ROOT,port:Number(process.env.AFH_ACCESS_PORT||4492)});
 app.server.listen(Number(process.env.AFH_ACCESS_PORT||4492),'127.0.0.1',()=>console.log('ORBITA ACCESS http://127.0.0.1:'+app.server.address().port+'/access'));
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>app.close().then(()=>process.exit(0)));
}
