// Test-only faults injected into the worker's owned child, never into production
// options, external processes, or the inherited test assertions.
const {isMainThread} = require('node:worker_threads');
if (!isMainThread && process.env.ORBITA_SQLITE_PROBE_FAULT) {
  const cp=require('node:child_process'),fs=require('node:fs');
  const spawn=cp.spawn,mode=process.env.ORBITA_SQLITE_PROBE_FAULT;
  cp.spawn=function(exe,args,options){
    if (!args?.some(x=>typeof x==='string'&&x.includes('dbs = {}')&&x.includes('sqlite3'))) return spawn.call(this,exe,args,options);
    let actual=[...args];
    if(mode==='stderr-flood') actual[2]='import sys\nsys.stderr.write("diagnostic " * 30000)\nsys.stderr.flush()\n'+actual[2];
    if(mode==='utf8-fragments') actual[2]=actual[2].replace('json.dumps(res)', 'json.dumps(res, ensure_ascii=False)');
    const child=spawn.call(this,exe,actual,options);
    const log=(event,extra={})=>fs.appendFileSync(process.env.ORBITA_SQLITE_PROBE_TRACE,JSON.stringify({event,pid:child.pid,...extra})+'\n');
    child.once('spawn',()=>{log('spawn');if(mode==='early-exit'){log('fault');child.kill();}});
    child.once('close',(code,signal)=>log('child-close',{code,signal}));
    let armed=false,response='';
    const write=child.stdin.write.bind(child.stdin);
    child.stdin.write=function(chunk,...rest){
      let req;try{req=JSON.parse(String(chunk));}catch{}
      if(req?.sql?.includes('fault-point')) {
        log('fault',{mode});
        if(mode==='exit-on-request'){child.kill();return true;}
        if(mode==='hang-on-request')return true;
        armed=true;
      }
      return write(chunk,...rest);
    };
    const emit=child.stdout.emit.bind(child.stdout);
    child.stdout.emit=function(event,...args){
      if(event==='data'&&armed){
        response+=String(args[0]);
        if(response.includes('\n')){
          const parsed=JSON.parse(response.split('\n')[0]);
          log('acknowledgement-intercepted',{ok:parsed.ok,changes:parsed.changes});
          armed=false;
          if(mode==='after-commit-exit'){child.kill();return true;}
          if(mode==='invalid-response')return emit(event,Buffer.from('{invalid-json\n'));
        }
        return true;
      }
      if(event==='data'&&mode==='utf8-fragments'){
        const bytes=args[0];
        for(let i=0;i<bytes.length;i++)emit(event,bytes.subarray(i,i+1));
        return true;
      }
      return emit(event,...args);
    };
    return child;
  };
}
