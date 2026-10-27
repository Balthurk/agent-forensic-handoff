const original=window.fetch.bind(window),response=await original('/access/api/session',{cache:'no-store'});
if(!response.ok){location.replace('/access');throw new Error('ACCESS_SESSION_REQUIRED');}
const session=await response.json();
window.fetch=async(input,init={})=>{
 const url=new URL(typeof input==='string'?input:input.url,location.href),method=String(init.method||(input instanceof Request?input.method:'GET')).toUpperCase();
 if(url.origin===location.origin&&url.pathname.startsWith('/api/')){
  const headers=new Headers(init.headers||(input instanceof Request?input.headers:undefined));headers.set('x-orbita-workspace',session.selected);if(method!=='GET')headers.set('x-orbita-csrf',session.csrf);
  const r=await original(input,{...init,headers,cache:'no-store'});
  if(r.status===401||r.status===409&&((await r.clone().json()).error==='ACCESS_TAB_WORKSPACE_CHANGED')){document.body.replaceChildren();location.replace('/access');}
  return r;
 }return original(input,init);
};
export {session};
setInterval(async()=>{try{const r=await original('/access/api/session',{cache:'no-store'}),s=r.ok?await r.json():null;if(!s||s.selected!==session.selected||!s.spaces.some(w=>w.id===session.selected&&w.available)){document.body.replaceChildren();location.replace('/access');}}catch{document.body.replaceChildren();location.replace('/access');}},3000);
