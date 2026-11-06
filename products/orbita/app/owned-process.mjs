import {execFile,spawn} from 'node:child_process';
import {Utf8Stream} from './utf8-stream.mjs';
export function terminateOwned(child){if(!child?.pid)return;if(process.platform==='win32')execFile('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{});else child.kill('SIGKILL');}

// Provider children receive platform/runtime locations, never database authority,
// another provider's credentials, or inherited preload hooks.
export function providerEnvironment({codex=false}={}){
 const allowed=new Set(['systemroot','windir','comspec','path','pathext','temp','tmp','lang','lc_all','tz']);
 if(codex)for(const key of ['home','userprofile','appdata','localappdata','codex_home'])allowed.add(key);
 return Object.fromEntries(Object.entries(process.env).filter(([key])=>allowed.has(key.toLowerCase())));
}

// Cancellation retains ownership until the actual close event, including pipes.
// A delayed kill fallback uses Node's held child handle, not a recycled PID.
export function runOwnedProcess(executable,args,{env,cwd,input='',signal,timeout=25000,stdoutLimit=500000,stderrLimit=100000,totalLimit=Infinity}={}){
 signal?.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const started=Date.now(),stdout=new Utf8Stream(stdoutLimit),stderr=new Utf8Stream(stderrLimit);
  const child=spawn(executable,args,{env,cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let failure=null,done=false,timer,forceTimer;
  const cleanup=()=>{clearTimeout(timer);clearTimeout(forceTimer);signal?.removeEventListener('abort',cancel);};
  const stop=error=>{
   if(done||failure)return;failure=error;clearTimeout(timer);
   if(child.pid&&child.exitCode===null&&child.signalCode===null)terminateOwned(child);
   forceTimer=setTimeout(()=>{if(child.pid&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},5000);
  };
  const cancel=()=>stop(signal?.reason??new Error('CALLER_CANCELLED'));
  const receive=(stream,bytes)=>{
   if(failure)return;
   try{if(stdout.bytes+stderr.bytes+bytes.length>totalLimit)throw new Error('OWNED_PROCESS_OUTPUT_BUDGET');stream.push(bytes);}catch(error){stop(error);}
  };
  child.stdout.on('data',bytes=>receive(stdout,bytes));child.stderr.on('data',bytes=>receive(stderr,bytes));
  for(const stream of [child.stdin,child.stdout,child.stderr])stream.on('error',stop);
  child.on('error',stop);
  child.once('close',(code,exitSignal)=>{
   if(done)return;done=true;cleanup();
   if(!failure)try{stdout.end();stderr.end();}catch(error){failure=error;}
   const capture={stdout:stdout.text,stderr:stderr.text,code,signal:exitSignal,closed:true,pid:child.pid??null,startedAt:new Date(started).toISOString(),elapsedMs:Date.now()-started};
   if(failure){if(!(failure instanceof Error))failure=new Error(String(failure));failure.capture=capture;reject(failure);}else resolve(capture);
  });
  timer=setTimeout(()=>stop(new Error('OWNED_PROCESS_TIMEOUT')),Math.max(1,timeout));
  signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  if(!failure)child.stdin.end(input);else child.stdin.destroy();
 });
}
