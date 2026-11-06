import {parentPort,workerData} from 'node:worker_threads';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';

const env={...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1'};
for(const name of Object.keys(env))if(name.startsWith('ORBITA_POSTGRES_TEST_')||name.includes('POSTGRES_OPERATOR'))delete env[name];
const child=spawn(workerData.python,['-X','utf8','-B','-u','-m','orbita_store.bridge'],{cwd:workerData.pythonRoot,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
const decoder=new StringDecoder('utf8');
let pending=null,terminal=null,pieces=[],size=0,shutdownResponse=null,stopped=false;

function reply(value){
  if(!pending)return;
  const {port,sab}=pending;pending=null;
  try{port.postMessage(value);}finally{port.close();const signal=new Int32Array(sab);Atomics.store(signal,0,1);Atomics.notify(signal,0,1);}
}
function fail(code){
  terminal??={ok:false,fatal:true,code,error:code};
  reply({...terminal,id:pending?.id});
}
function stop(){
  if(stopped)return;stopped=true;
  child.stdin.destroy();
  if(child.exitCode===null&&child.signalCode===null){
    child.kill();
    const timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},1000);
    timer.unref();child.once('close',()=>clearTimeout(timer));
  }
  parentPort.close();
}
child.on('error',()=>fail('ORBITA_PG_BRIDGE_START_FAILED'));
child.stdin.on('error',()=>fail('ORBITA_PG_BRIDGE_INPUT_FAILED'));
child.stdout.on('error',()=>fail('ORBITA_PG_BRIDGE_OUTPUT_FAILED'));
// Drain without echoing potentially private backend diagnostics.
child.stderr.on('data',()=>{});child.stderr.on('error',()=>{});
child.stdout.on('data',chunk=>{
  const text=decoder.write(chunk);let start=0,index=text.indexOf('\n');
  size+=chunk.length;
  if(size>32*1024*1024){fail('ORBITA_PG_BRIDGE_RESPONSE_LIMIT');stop();return;}
  while(index!==-1){
    pieces.push(text.slice(start,index));const line=pieces.join('');pieces=[];size=0;
    let response;
    try{response=JSON.parse(line);}catch{fail('ORBITA_PG_BRIDGE_PROTOCOL');stop();return;}
    if(!pending||response.id!==pending.id||typeof response.ok!=='boolean'){fail('ORBITA_PG_BRIDGE_PROTOCOL');stop();return;}
    if(pending.shutdown){shutdownResponse=response;child.stdin.end();}
    else reply(response);
    start=index+1;index=text.indexOf('\n',start);
  }
  if(start<text.length)pieces.push(text.slice(start));
});
child.on('close',(code,signal)=>{
  if(shutdownResponse?.ok&&code===0&&!signal){reply({...shutdownResponse,ownedExit:code,drained:true});parentPort.close();}
  else fail('ORBITA_PG_BRIDGE_EXIT');
});
parentPort.on('message',message=>{
  if(message.cancel){stop();return;}
  if(pending){fail('ORBITA_PG_BRIDGE_CONCURRENT_REQUEST');stop();return;}
  pending=message;
  if(terminal){reply({...terminal,id:message.id});return;}
  try{child.stdin.write(message.req+'\n');}catch{fail('ORBITA_PG_BRIDGE_INPUT_FAILED');}
});
parentPort.on('close',stop);
process.once('exit',()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();});
