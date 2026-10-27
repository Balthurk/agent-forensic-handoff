const trigger=document.createElement('button');trigger.className='add-source';trigger.type='button';trigger.textContent='◇ Respaldo y recuperación';document.querySelector('#addSource').after(trigger);
const details=document.createElement('dialog');details.className='source-dialog';
details.innerHTML=`<button type="button" class="close" id="recoveryClose" aria-label="Cerrar recuperación">×</button><h2>Respaldo y recuperación</h2>
<p>Conserva originales, versiones, decisiones, índices y trabajos. Durante la copia se pausa el acceso al almacén.</p>
<div class="p1-controls"><label>Archivo de backup (.orbita)<input id="recoveryArchive" placeholder="C:\\Backups\\mi-memoria.orbita"></label>
<label>Contraseña de al menos 12 caracteres<input id="recoveryPassword" type="password" autocomplete="new-password"></label>
<label>Carpeta nueva para restaurar<input id="recoveryDestination" placeholder="C:\\Memoria\\restaurada"></label></div>
<div class="p1-actions"><button id="recoveryBackup" type="button">Crear backup cifrado</button><button id="recoveryRestore" type="button">Restaurar en carpeta nueva</button><button id="recoveryStatus" type="button">Estado de recuperación</button></div>
<p>Guarda la contraseña: no se incluye en el backup. La restauración conserva el historial y empieza con tareas automáticas y accesos externos pausados.</p>
<div id="recoveryActivation" hidden><label><input id="recoveryAutomatic" type="checkbox"> Reactivar revisiones automáticas previamente configuradas</label><label><input id="recoveryExternal" type="checkbox"> Permitir rutas de captura y almacenes externos registrados</label><button id="recoveryActivate" type="button">Aplicar reactivación a este almacén</button></div>
<pre id="recoveryResult" role="status" aria-live="polite"></pre>`;
document.body.append(details);trigger.onclick=()=>details.showModal();
const $=id=>details.querySelector('#'+id),result=$('recoveryResult');let current=null,busy=false;
$('recoveryClose').onclick=()=>details.close();
async function api(url,body){const r=await fetch(url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const data=await r.json();if(!r.ok)throw new Error(data.error||'No se pudo completar la operación');return data;}
async function status(){current=await api('/api/recovery/status');$('recoveryActivation').hidden=!current.restored;result.textContent=current.restored?`Última restauración verificada: ${current.restored.files} archivos · ${new Date(current.restored.restoredAt).toLocaleString()}\nEl recibo corresponde a ese corte; no incluye cambios posteriores.\nAutomáticas: ${current.restored.automaticWork?'activas':'pausadas'} · rutas externas: ${current.restored.externalAccess?'permitidas':'pausadas'}`:'Este almacén no procede de una restauración registrada.';}
async function run(op){if(busy)return;busy=true;for(const b of details.querySelectorAll('button'))b.disabled=true;
 try{const password=$('recoveryPassword').value,archive=$('recoveryArchive').value.trim(),destination=$('recoveryDestination').value.trim();$('recoveryPassword').value='';
  result.textContent=op==='backup'?'Verificando el corte y creando backup…':'Autenticando y verificando la restauración…';
  const job=await api('/api/recovery',{op,archive,password,...(op==='restore'?{destination}:{})});let state;
  do{await new Promise(resolve=>setTimeout(resolve,800));state=await api('/api/jobs/'+job.id);}while(state.status==='running');
  if(state.status!=='complete')throw new Error(state.error||'Operación incompleta');
  result.textContent=op==='backup'?`Backup verificado: ${state.result.files} archivos · ${state.result.bytes.toLocaleString()} bytes\n${state.result.archive}\nSHA-256 ${state.result.archiveSha256}`:`Restauración verificada: ${state.result.files} archivos\n${state.result.destination}\nSe mantiene abierto el almacén actual. Abre la carpeta restaurada con START.ps1 -Data <carpeta> para consultar o reactivar sus tareas.`;
 }catch(e){result.textContent=e.message;}finally{busy=false;for(const b of details.querySelectorAll('button'))b.disabled=false;}}
$('recoveryBackup').onclick=()=>run('backup');$('recoveryRestore').onclick=()=>run('restore');$('recoveryStatus').onclick=()=>status().catch(e=>result.textContent=e.message);
$('recoveryActivate').onclick=async()=>{try{await api('/api/recovery/activate',{restoreId:current?.restored?.id,automaticWork:$('recoveryAutomatic').checked,externalAccess:$('recoveryExternal').checked});await status();}catch(e){result.textContent=e.message;}};
