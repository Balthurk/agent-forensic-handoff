// These annotations describe UI actions; the gateway reauthorizes every request.
export function sameManagedSession(current,next){
 // A fresh login can replace the HttpOnly cookie without changing any role.
 // The old tab must discard its data and CSRF token on that transition too.
 return !!current?.selected&&typeof current.user?.id==='string'&&typeof current.csrf==='string'&&!!current.csrf&&
  !!next&&next.user?.id===current.user.id&&next.csrf===current.csrf&&next.selected===current.selected&&
  current.capabilities?.version===1&&Array.isArray(current.capabilities.actions)&&
  next.capabilities?.version===1&&Array.isArray(next.capabilities.actions)&&
  JSON.stringify(next.capabilities)===JSON.stringify(current.capabilities)&&
  Array.isArray(next.spaces)&&next.spaces.some(w=>w.id===current.selected&&w.available);
}

export function installManagedPermissions(session){
 const allowed=new Set(session.capabilities?.version===1?session.capabilities.actions:[]);
 const selector='[data-access-action]';
 function apply(root){
  const nodes=[...(root.matches?.(selector)?[root]:[]),...(root.querySelectorAll?.(selector)||[])];
  for(const node of nodes)if(!allowed.has(node.dataset.accessAction)){
   node.dataset.accessDenied='true';node.inert=true;
   if(node.matches('button,input,select,textarea,option'))node.disabled=true;
  }
 }
 apply(document);
 document.documentElement.setAttribute('data-access-ready','');
 const observer=new MutationObserver(records=>{for(const r of records){if(r.type==='attributes')apply(r.target);else for(const node of r.addedNodes)apply(node);}});
 observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['data-access-action']});
 for(const type of ['click','submit'])document.addEventListener(type,event=>{
  for(let node=event.target?.closest?.(selector);node;node=node.parentElement?.closest(selector))if(!allowed.has(node.dataset.accessAction)){event.preventDefault();event.stopImmediatePropagation();return;}
 },true);
 return observer;
}
