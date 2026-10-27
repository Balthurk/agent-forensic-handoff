const $=id=>document.getElementById(id);let session=null,current=null,plan=null;
const stateNames={active:'Activo',suspended:'Suspendido',purge_prepared:'Plan de borrado preparado',purge_failed:'Borrado incompleto · acceso bloqueado',maintenance:'Mantenimiento',purged:'Eliminado'};
const text=(tag,value,className)=>{const e=document.createElement(tag);e.textContent=value;if(className)e.className=className;return e;};
const action=(label,fn)=>{const b=text('button',label);b.type='button';b.onclick=()=>run(fn);return b;};
const local=value=>{const d=new Date(value);return new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
const policyFrom=form=>({basis:form.elements.basis.value,purpose:form.elements.purpose.value,rightsUntil:new Date(form.elements.rightsUntil.value).toISOString(),retainUntil:new Date(form.elements.retainUntil.value).toISOString()});
async function api(route,body){const r=await fetch('/access/api/'+route,{cache:'no-store',...(body?{method:'POST',headers:{'content-type':'application/json','x-orbita-csrf':session?.csrf||''},body:JSON.stringify(body)}:{})});const result=await r.json();if(!r.ok)throw new Error(result.error);return result;}
async function run(fn){$('status').textContent='';$('manageStatus').textContent='Comprobando…';try{const result=await fn();$('manageStatus').textContent=typeof result==='string'?result:'Operación registrada.';}catch(e){$('status').textContent=e.message;$('manageStatus').textContent=e.message;}}
async function refresh(){
 try{session=await api('session');}catch{session=null;}
 $('login').hidden=!!session;$('dashboard').hidden=!session;$('logout').hidden=!session;if(!session)return;
 $('identity').textContent=session.user.name;$('accounts').hidden=!session.user.admin;$('spaces').replaceChildren();
 for(const w of session.spaces){const card=text('article','', 'card');card.append(text('h3',w.name),text('span',stateNames[w.status]||w.status,'badge '+(w.available?'':'paused')),text('small',w.role+' · '+w.id));
  if(w.policy.retainUntil)card.append(text('p','Conservar hasta '+new Date(w.policy.retainUntil).toLocaleString()));
  if(w.reason)card.append(text('small',w.reason));
  if(w.available)card.append(action('Explorar',async()=>{await api('select',{id:w.id});location.assign('/');}));
  if(w.role==='owner'&&w.status!=='purged')card.append(action('Gestionar',()=>manage(w.id)));$('spaces').append(card);
 }
 if(!session.spaces.length)$('spaces').append(text('p','Todavía no tienes espacios. Crea uno o pide acceso a su propietario.'));
}
async function manage(id){await refresh();current=session.spaces.find(w=>w.id===id);plan=null;$('purgeControls').hidden=true;$('token').hidden=true;$('token').value='';$('inventory').textContent='';$('manageStatus').textContent='';$('spaceName').textContent=current.name;
 $('policySummary').textContent=`${stateNames[current.status]} · ${current.policy.purpose} · Permiso hasta ${new Date(current.policy.rightsUntil).toLocaleString()}`;
 const f=$('policy');for(const k of ['basis','purpose'])f.elements[k].value=current.policy[k];for(const k of ['rightsUntil','retainUntil'])f.elements[k].value=local(current.policy[k]);f.elements.legalHold.checked=current.legalHold;
 $('members').replaceChildren();for(const m of await api('members?id='+id)){const row=text('div','','member');row.append(text('span',m.name+' · '+m.role));if(m.role!=='owner')row.append(action('Revocar '+m.name,async()=>{await api('revoke',{id,user:m.id});await manage(id);return 'Acceso revocado. Las consultas en curso han sido detenidas.';}));$('members').append(row);}
 $('backupId').replaceChildren();for(const b of await api('backups?id='+id)){const o=text('option',new Date(b.createdAt).toLocaleString()+' · '+b.files+' archivos');o.value=b.id;$('backupId').append(o);}
 $('copies').replaceChildren();for(const c of current.externalCopies){const row=text('div','','copy');row.append(text('span',c.label+' · '+c.state));if(c.state==='outstanding')row.append(action('Declarar borrada',async()=>{await api('copy-deleted',{id,copyId:c.id,reason:'El propietario declara que eliminó la copia externa'});await manage(id);return 'Declaración guardada; eliminación externa no verificada por Órbita.';}));$('copies').append(row);}
 if(!$('manage').open)$('manage').showModal();
}
$('login').onsubmit=async e=>{e.preventDefault();const form=e.target,password=form.elements.password.value;form.elements.password.value='';try{const r=await fetch('/access/api/login',{method:'POST',headers:{'content-type':'application/json','x-orbita-login':'1'},body:JSON.stringify({username:form.elements.username.value,password})});const v=await r.json();if(!r.ok)throw new Error(v.error);$('status').textContent='Sesión iniciada.';await refresh();}catch(err){$('status').textContent=err.message;}};
$('logout').onclick=()=>run(async()=>{await api('logout',{});$('manage').close();await refresh();return 'Sesión cerrada.';});
$('closeManage').onclick=()=>{$('token').value='';$('manage').close();};
$('createAccount').onsubmit=e=>{e.preventDefault();void run(async()=>{const f=e.target;await api('accounts',{username:f.elements.username.value,password:f.elements.password.value});f.reset();return 'Cuenta creada. Concede acceso desde el espacio correspondiente.';});};
$('createSpace').onsubmit=e=>{e.preventDefault();void run(async()=>{const f=e.target;await api('workspaces',{name:f.elements.name.value,policy:policyFrom(f)});f.reset();await refresh();return 'Espacio creado.';});};
$('grant').onsubmit=e=>{e.preventDefault();void run(async()=>{await api('grant',{id:current.id,username:e.target.elements.username.value,role:e.target.elements.role.value});await manage(current.id);});};
$('openSpace').onclick=()=>run(async()=>{await api('select',{id:current.id});location.assign('/');});
$('recoverMaintenance').onclick=()=>run(async()=>{await api('maintenance-recover',{id:current.id});await manage(current.id);return 'Datos verificados; el espacio sigue suspendido hasta que lo reanudes.';});
for(const [button,suspended] of [['pauseSpace',true],['resumeSpace',false]])$(button).onclick=()=>run(async()=>{await api('policy',{id:current.id,suspended,reason:suspended?'Suspensión solicitada por el propietario':'Reanudación solicitada por el propietario'});await manage(current.id);});
$('policy').onsubmit=e=>{e.preventDefault();void run(async()=>{await api('policy',{id:current.id,policy:policyFrom(e.target),legalHold:e.target.elements.legalHold.checked,reason:e.target.elements.reason.value});await manage(current.id);});};
$('agentToken').onclick=()=>run(async()=>{const t=await api('token',{id:current.id});$('token').value=t.token;$('token').hidden=false;return 'Credencial creada. Caduca: '+t.expiresAt;});
$('backup').onclick=()=>run(async()=>{const password=$('backupPassword').value;$('backupPassword').value='';await api('backup',{id:current.id,password});await manage(current.id);return 'Copia cifrada y verificada.';});
$('restore').onclick=()=>run(async()=>{const password=$('backupPassword').value;$('backupPassword').value='';const r=await api('restore',{id:current.id,backupId:$('backupId').value,password});await manage(current.id);return `${r.files} archivos restaurados. Permisos y revocaciones actuales conservados.`;});
$('export').onclick=()=>run(async()=>{const r=await fetch('/access/api/export',{method:'POST',headers:{'content-type':'application/json','x-orbita-csrf':session.csrf},body:JSON.stringify({id:current.id,backupId:$('backupId').value})});if(!r.ok)throw new Error((await r.json()).error);const url=URL.createObjectURL(await r.blob()),a=document.createElement('a');a.href=url;a.download='orbita-'+$('backupId').value+'.orbita';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);await manage(current.id);return 'Copia descargada y registrada como externa.';});
$('preview').onclick=()=>run(async()=>{const r=await api('preview',{id:current.id});$('inventory').textContent=JSON.stringify(r.inventory,null,2);return 'Inventario informativo. El plan fijará un corte con el espacio pausado.';});
$('plan').onclick=()=>run(async()=>{plan=await api('purge-plan',{id:current.id});$('planSummary').textContent=`${plan.snapshot.files} archivos · ${plan.snapshot.bytes} bytes. Expira ${plan.expiresAt}. Confirma: ${plan.confirmation}`;$('purgeControls').hidden=false;$('confirmation').value='';return 'Espacio pausado. Todavía no se ha borrado ningún archivo.';});
$('cancelPurge').onclick=()=>run(async()=>{await api('purge-cancel',{id:current.id});await manage(current.id);return 'Plan cancelado. El espacio sigue suspendido hasta que lo reanudes.';});
$('purge').onclick=()=>run(async()=>{const r=await api('purge',{id:current.id,planId:plan?.id,confirmation:$('confirmation').value});$('manage').close();await refresh();$('status').textContent=`Borrado verificado de ${r.files} archivos administrados. No certifica eliminación física ni copias externas.`;return 'Borrado verificado.';});
await refresh();
