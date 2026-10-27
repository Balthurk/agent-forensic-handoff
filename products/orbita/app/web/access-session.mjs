import {sameManagedSession} from './managed-permissions.mjs';
const original=window.fetch.bind(window),response=await original('/access/api/session',{cache:'no-store'});
if(!response.ok){location.replace('/access');throw new Error('ACCESS_SESSION_REQUIRED');}
const session=await response.json();
let invalid=false;
function invalidate(){if(invalid)return;invalid=true;document.body.replaceChildren();location.replace('/access');}
window.fetch=async(input,init={})=>{
 const url=new URL(typeof input==='string'?input:input.url,location.href),method=String(init.method||(input instanceof Request?input.method:'GET')).toUpperCase();
 if(url.origin===location.origin&&url.pathname.startsWith('/api/')){
  const headers=new Headers(init.headers||(input instanceof Request?input.headers:undefined));headers.set('x-orbita-workspace',session.selected);if(method!=='GET')headers.set('x-orbita-csrf',session.csrf);
  const r=await original(input,{...init,headers,cache:'no-store'});
  if(r.status===401)invalidate();
  else if(r.status===403||r.status===409){const error=await r.clone().json().catch(()=>({}));if(['ACCESS_DENIED','ACCESS_CSRF_REQUIRED','ACCESS_TAB_WORKSPACE_CHANGED','ACCESS_CHANGED_DURING_REQUEST','ACCESS_WORKSPACE_PAUSED','ACCESS_SOURCE_RIGHTS_EXPIRED','ACCESS_RETENTION_EXPIRED'].includes(error.error))invalidate();}
  return r;
 }return original(input,init);
};
export {session};
setInterval(async()=>{try{const r=await original('/access/api/session',{cache:'no-store'}),s=r.ok?await r.json():null;if(!sameManagedSession(session,s))invalidate();}catch{invalidate();}},3000);
