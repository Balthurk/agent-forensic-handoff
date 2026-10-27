import {session} from './access-session.mjs';
import {installManagedPermissions} from './managed-permissions.mjs';
installManagedPermissions(session);
const {ready}=await import('/app.js');await ready;
document.querySelector('#auth').textContent='Espacio autenticado';
document.querySelector('.model-wrap').dataset.accessAction='POST /api/ask';
document.querySelector('#routingConnection').dataset.accessAction='POST /api/ask';
await Promise.all(['/learning-web.mjs','/decisions-web.mjs','/documents-web.mjs','/collectives-web.mjs','/supports-web.mjs','/identities-web.mjs','/volume-web.mjs','/retrospectives-web.mjs','/decision-intelligence-web.mjs','/causal-web.mjs','/graph-publication-web.mjs'].map(x=>import(x)));
const w=session.spaces.find(w=>w.id===session.selected),crumb=document.querySelector('.breadcrumb');if(crumb)crumb.textContent=(w?.name||'Espacio')+' / '+session.user.name;
const note=document.querySelector('.composer-note');note.textContent='Espacio autenticado · usa «Ver contexto sin LLM». La inferencia externa requiere una conexión propia.';
const preview=()=>document.querySelector('#previewButton').click(),question=document.querySelector('#question'),send=document.querySelector('#send');send.setAttribute('aria-label','Recuperar contexto');send.title='Recuperar contexto verificado';
document.querySelector('#askForm').addEventListener('submit',e=>{e.preventDefault();e.stopImmediatePropagation();preview();},{capture:true});
question.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();e.stopImmediatePropagation();preview();}},{capture:true});
for(const button of document.querySelectorAll('[data-question]'))button.addEventListener('click',e=>{e.stopImmediatePropagation();question.value=button.dataset.question;question.dispatchEvent(new Event('input',{bubbles:true}));preview();},{capture:true});
const sourceUrl=document.querySelector('#sourceUrl');sourceUrl.disabled=true;sourceUrl.placeholder='Importa un archivo en este espacio';
for(const o of document.querySelector('#routingPolicy').options)if(o.value!=='local')o.disabled=true;
// A normal link navigation cannot carry this tab's workspace header. Fetch the
// download through the same authenticated wrapper, then save the returned blob.
document.addEventListener('click',async event=>{
 const anchor=event.target.closest?.('a[href]');if(!anchor)return;const url=new URL(anchor.href,location.href);
 if(url.origin!==location.origin||!['/api/documents/original','/api/export'].includes(url.pathname))return;
 event.preventDefault();event.stopImmediatePropagation();
 try{const response=await fetch(url.href);if(!response.ok)throw new Error((await response.json()).error||'ACCESS_DOWNLOAD_FAILED');
  const blob=URL.createObjectURL(await response.blob()),a=document.createElement('a'),header=response.headers.get('content-disposition')||'',encoded=/filename\*=UTF-8''([^;]+)/.exec(header);
  a.href=blob;a.download=encoded?decodeURIComponent(encoded[1]):'orbita-original.json';a.click();setTimeout(()=>URL.revokeObjectURL(blob),30000);
 }catch(e){document.querySelector('#toast').textContent='Descarga no publicada: '+e.message;}
},{capture:true});
