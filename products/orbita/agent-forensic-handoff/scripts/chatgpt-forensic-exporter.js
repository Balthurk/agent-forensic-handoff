/* AFH exporter v8-intake-identity. Paste only on chatgpt.com, or import its pure
 * functions in a test. No external scripts, automatic fetch, or token storage. */
(function (global) {
  'use strict';
  const encoder=new TextEncoder();
  const FORMAT='afh.conversation.v1';
  const bytes=value=>typeof value==='string'?encoder.encode(value):new Uint8Array(value);
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const hash=async value=>Array.from(new Uint8Array(await global.crypto.subtle.digest('SHA-256',bytes(value))),n=>n.toString(16).padStart(2,'0')).join('');
  const base64=value=>{let out='';for(let i=0;i<value.length;i+=0x8000)out+=String.fromCharCode(...value.subarray(i,i+0x8000));return global.btoa(out);};

  function validate(conversation) {
    if(!conversation||typeof conversation.mapping!=='object'||Array.isArray(conversation.mapping)||!conversation.mapping)throw new Error('Se necesita un JSON con mapping completo.');
    for(const [id,node] of Object.entries(conversation.mapping))if(!node||node.id!==id)throw new Error('Identidad de nodo inconsistente.');
    return conversation;
  }
  function orderedNodes(conversation) {
    validate(conversation);const seen=new Set(),out=[],mapping=conversation.mapping;
    for(const node of Object.values(mapping)) {
      const chain=[],visiting=new Set();let cur=node;
      while(cur&&!seen.has(cur.id)&&!visiting.has(cur.id)){visiting.add(cur.id);chain.push(cur);cur=Object.hasOwn(mapping,cur.parent)?mapping[cur.parent]:null;}
      while(chain.length){const n=chain.pop();if(!seen.has(n.id)){seen.add(n.id);out.push(n);}}
    }
    return out;
  }
  function scope(conversation) {
    const active=new Set();let id=conversation.current_node,valid=Boolean(id&&Object.hasOwn(conversation.mapping,id));
    while(id&&Object.hasOwn(conversation.mapping,id)){if(active.has(id)){valid=false;break;}active.add(id);id=conversation.mapping[id].parent;}
    if(id&&!Object.hasOwn(conversation.mapping,id))valid=false;
    return n=>valid?(active.has(n.id)?'active':'alternative'):'unknown';
  }
  function text(content) {
    if(Array.isArray(content?.parts))return content.parts.map(p=>typeof p==='string'?p:JSON.stringify(p)).join('\n');
    if(typeof content?.text==='string')return content.text;
    return JSON.stringify(content??null,null,2);
  }
  function toJsonl(conversation) {
    const nodes=orderedNodes(conversation),header={...conversation};delete header.mapping;
    return [{type:'afh.export.header',format:FORMAT,conversation:header,nodeCount:nodes.length},...nodes.map(node=>({type:'afh.export.node',node}))].map(x=>JSON.stringify(x)).join('\n')+'\n';
  }
  function toMarkdown(conversation) {
    const label=scope(conversation);
    return '# '+(conversation.title||'Conversación')+'\n\nProyección de lectura; el original JSON conserva la autoridad.\n\n'+orderedNodes(conversation).map(n=>'## '+(n.message?.author?.role||'node')+' · '+n.id+' · '+label(n)+'\n\n'+(n.message?text(n.message.content):'[Nodo sin mensaje]')+'\n').join('\n');
  }
  function toHtml(conversation, originalText=JSON.stringify(conversation)) {
    validate(conversation);
    const original=JSON.parse(originalText);
    if(JSON.stringify(original)!==JSON.stringify(conversation))throw new Error('El original no coincide con la conversación.');
    const label=scope(conversation);
    return '<!doctype html><html lang="es"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'none\'; base-uri \'none\'; form-action \'none\'"><meta name="viewport" content="width=device-width"><title>'+escape(conversation.title)+'</title><style>body{background:#080b1c;color:#e7eafb;font:16px system-ui;max-width:960px;margin:48px auto;padding:24px}article{background:#151a34;padding:24px;margin:18px 0;border:1px solid #384366;border-radius:18px}h2{font-size:14px;color:#a8b6ff}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}</style><h1>'+escape(conversation.title||'Conversación')+'</h1><p>Instantánea publicada/exportada. Ramas alternativas y nodos sin mensaje conservados. Sin recursos externos ni ejecución de contenido.</p>'+orderedNodes(conversation).map(n=>'<article><h2>'+escape(n.message?.author?.role||'node')+' · '+escape(n.id)+' · '+label(n)+'</h2><pre>'+escape(n.message?text(n.message.content):'[Nodo sin mensaje]')+'</pre></article>').join('')+'<script id="afh-original" type="application/octet-stream">'+base64(bytes(originalText))+'</script></html>';
  }
  const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
  function crc32(data){let n=0xffffffff;for(const b of data)n=crcTable[(n^b)&255]^(n>>>8);return(n^0xffffffff)>>>0;}
  function safeName(name,used) {
    let n=String(name).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').slice(0,160)||'file';
    if(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(n))n='_'+n;
    const original=n;let i=1;while(used.has(n.toLowerCase()))n=`${i++}-${original}`;used.add(n.toLowerCase());return n;
  }
  function makeZip(entries) {
    if(entries.length>10000)throw new Error('Demasiados ficheros');
    const chunks=[],central=[];let offset=0,total=0;const names=new Set();
    for(const entry of entries) {
      const name=bytes(entry.name),data=bytes(entry.data);
      if(!entry.name||entry.name.split('/').some(p=>p==='..'||p==='.'||!p)||/[\\:\x00]/.test(entry.name)||entry.name.startsWith('/')||names.has(entry.name.toLowerCase()))throw new Error('Nombre ZIP inválido o duplicado');
      names.add(entry.name.toLowerCase());total+=data.length;
      if(total>256*1024*1024)throw new Error('ZIP supera 256 MiB');
      const crc=crc32(data),local=new Uint8Array(30+name.length),lv=new DataView(local.buffer);
      lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint16(6,0x800,true);lv.setUint32(14,crc,true);lv.setUint32(18,data.length,true);lv.setUint32(22,data.length,true);lv.setUint16(26,name.length,true);local.set(name,30);
      const cd=new Uint8Array(46+name.length),cv=new DataView(cd.buffer);
      cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x800,true);cv.setUint32(16,crc,true);cv.setUint32(20,data.length,true);cv.setUint32(24,data.length,true);cv.setUint16(28,name.length,true);cv.setUint32(42,offset,true);cd.set(name,46);
      chunks.push(local,data);central.push(cd);offset+=local.length+data.length;
    }
    const centralBytes=central.reduce((s,x)=>s+x.length,0),end=new Uint8Array(22),ev=new DataView(end.buffer);
    ev.setUint32(0,0x06054b50,true);ev.setUint16(8,entries.length,true);ev.setUint16(10,entries.length,true);ev.setUint32(12,centralBytes,true);ev.setUint32(16,offset,true);
    const result=new Uint8Array(offset+centralBytes+22);let p=0;
    for(const chunk of [...chunks,...central,end]){result.set(chunk,p);p+=chunk.length;}return result;
  }
  async function bundle(conversation,originalText=JSON.stringify(conversation),files=[],acquisition={kind:'provided-json'}) {
    validate(conversation);const entries=[{name:'conversation.json',data:bytes(originalText)},{name:'conversation.jsonl',data:bytes(toJsonl(conversation))},{name:'conversation.html',data:bytes(toHtml(conversation,originalText))},{name:'conversation.md',data:bytes(toMarkdown(conversation))}],used=new Set(),attachments=[];
    const references=orderedNodes(conversation).flatMap(n=>(n.message?.metadata?.attachments||[]).map(a=>({message_id:n.message.id,reference:a,status:'REFERENCE_ONLY_UNRESOLVED'})));
    for(const file of files) {
      if(file.error){attachments.push({reference:file.reference??null,status:'DOWNLOAD_FAILED',error:String(file.error)});continue;}
      const name='files/'+safeName(file.name,used),data=bytes(file.data);
      entries.push({name,data});attachments.push({path:name,bytes:data.length,sha256:await hash(data),reference:file.reference??null,status:file.reference?'DOWNLOADED_UNVERIFIED_BINDING':'PROVIDED_UNBOUND'});
    }
    const manifest={format:'afh.export-acquisition.v1',captured_at:new Date().toISOString(),acquisition,original_sha256:await hash(bytes(originalText)),node_count:Object.keys(conversation.mapping).length,message_count:orderedNodes(conversation).filter(n=>n.message).length,attachments,references,coverage:'EXPORTED_SNAPSHOT_ONLY'};
    entries.push({name:'acquisition.json',data:bytes(JSON.stringify(manifest,null,2))});return {bytes:makeZip(entries),manifest};
  }
  async function boundedFetch(url,{token=null,maxBytes=64*1024*1024,external=false}={}) {
    const target=new URL(url,global.location.origin);
    if(target.protocol!=='https:'||target.username||target.password||(!external&&target.origin!==global.location.origin))throw new Error('Destino de descarga no permitido');
    const headers=token?{Authorization:`Bearer ${token}`}:{},response=await global.fetch(target.href,{headers,credentials:external?'omit':'same-origin',redirect:'error',signal:AbortSignal.timeout(45000)});
    if(!response.ok)throw new Error('HTTP '+response.status);
    if(Number(response.headers.get('content-length'))>maxBytes)throw new Error('Límite de descarga');
    const chunks=[];let length=0;for await(const chunk of response.body){length+=chunk.length;if(length>maxBytes){await response.body.cancel?.().catch(()=>{});throw new Error('Límite de descarga');}chunks.push(chunk);}
    const data=new Uint8Array(length);let i=0;for(const chunk of chunks){data.set(chunk,i);i+=chunk.length;}return data;
  }
  async function acquireCurrent() {
    if(global.location.protocol!=='https:'||!['chatgpt.com','chat.openai.com'].includes(global.location.hostname))throw new Error('Abre primero ChatGPT.');
    const id=global.location.pathname.match(/^\/c\/([0-9a-f-]{36})\/?$/i)?.[1];
    if(!id)throw new Error('Abre una conversación /c/UUID. Para /share/ usa afh import-share.');
    const session=JSON.parse(new TextDecoder().decode(await boundedFetch('/api/auth/session',{maxBytes:1024*1024})));
    if(!session.accessToken)throw new Error('Sesión no disponible');
    const data=await boundedFetch('/backend-api/conversation/'+id,{token:session.accessToken});
    const original=new TextDecoder('utf-8',{fatal:true}).decode(data),conversation=validate(JSON.parse(original));
    if((conversation.conversation_id||conversation.id)!==id)throw new Error('La respuesta cambia la identidad solicitada');
    return {conversation,original,acquisition:{kind:'same-origin-api',path:'/backend-api/conversation/'+id,response_bytes:data.length}};
  }
  function start() {
    if(global.location.protocol!=='https:'||!['chatgpt.com','chat.openai.com'].includes(global.location.hostname))throw new Error('Este exportador solo se abre en ChatGPT HTTPS');
    if(global.document.getElementById('afh-exporter'))return;
    const panel=global.document.createElement('section');panel.id='afh-exporter';
    Object.assign(panel.style,{position:'fixed',right:'20px',top:'20px',zIndex:'2147483647',background:'#12162e',color:'#eef',padding:'24px',border:'1px solid #7583ce',borderRadius:'16px',maxWidth:'420px',font:'14px system-ui'});
    const heading=global.document.createElement('h2');heading.textContent='AFH · Exportación íntegra';panel.append(heading);
    const note=global.document.createElement('p');note.textContent='Conserva todos los nodos, ramas y campos. Los adjuntos no descargados quedan señalados. La descarga solo empieza al pulsar.';panel.append(note);
    const status=global.document.createElement('p');panel.append(status);
    const button=global.document.createElement('button');button.textContent='Exportar conversación actual a ZIP';panel.append(button);
    button.onclick=async()=>{button.disabled=true;status.textContent='Adquiriendo…';try{const acquired=await acquireCurrent(),result=await bundle(acquired.conversation,acquired.original,[],acquired.acquisition),url=URL.createObjectURL(new Blob([result.bytes],{type:'application/zip'})),link=global.document.createElement('a');link.href=url;link.download='chatgpt-afh-export.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);status.textContent=`${result.manifest.node_count} nodos conservados; ${result.manifest.references.length} referencias de adjuntos pendientes.`;}catch(error){status.textContent=error.message;}finally{button.disabled=false;}};
    const close=global.document.createElement('button');close.textContent='Cerrar';close.onclick=()=>panel.remove();panel.append(close);global.document.body.append(panel);
  }
  global.AFHExporter=Object.freeze({orderedNodes,toJsonl,toHtml,toMarkdown,makeZip,bundle,safeName,acquireCurrent,start});
  if(global.document)start();
})(globalThis);
