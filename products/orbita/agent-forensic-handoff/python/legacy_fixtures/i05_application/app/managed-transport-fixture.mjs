// Test-only passive socket inventory and one explicit lost-response fault.
// The real document handler completes before its actual response is dropped.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
if(process.env.AFH_MANAGED==='1'&&process.env.ORBITA_TRANSPORT_FIXTURE_DIR){
 const dir=path.join(process.env.ORBITA_TRANSPORT_FIXTURE_DIR,path.basename(path.dirname(process.env.AFH_COSMOS_DATA)));
 fs.mkdirSync(dir,{recursive:true});
 const log=value=>fs.appendFileSync(path.join(dir,'requests.jsonl'),JSON.stringify(value)+'\n');
 const sockets=new WeakMap();let sequence=0;const createServer=http.createServer;
 http.createServer=function(...args){
  const server=Reflect.apply(createServer,this,args);
  server.prependListener('request',(req,res)=>{
   if(!sockets.has(req.socket))sockets.set(req.socket,++sequence);
   const record={method:req.method,url:req.url,connection:req.headers.connection??null,socket:sockets.get(req.socket)};
   log({event:'request',...record});
   const end=res.end;
   res.end=function(...values){
    const flag=path.join(dir,'drop-document-response');
    if(req.method==='POST'&&req.url==='/api/documents'&&fs.existsSync(flag)){
     fs.unlinkSync(flag);log({event:'completed-response-dropped',...record,status:this.statusCode});
     req.socket.destroy();return this;
    }
    return Reflect.apply(end,this,values);
   };
  });
  return server;
 };
}
