// A response is active until both its handler and the transport have finished.
export function responseLease(res,release){
 let handlerDone=false,transportDone=res.writableFinished||res.destroyed,released=false;
 const finish=()=>{if(!released&&handlerDone&&transportDone){released=true;res.removeListener('finish',transport);res.removeListener('close',transport);release();}};
 const transport=()=>{transportDone=true;finish();};
 res.once('finish',transport);res.once('close',transport);
 return ()=>{handlerDone=true;finish();};
}

export class WorkerActivity{
 constructor(){this.http=0;this.jobs=new Set();this.quiesced=null;}
 request(res){
  if(this.quiesced)return null;
  this.http++;return responseLease(res,()=>this.http--);
 }
 background(work){
  const token={};this.jobs.add(token);
  return Promise.resolve().then(work).finally(()=>this.jobs.delete(token));
 }
 quiesce(nonce){
  if(this.quiesced)return this.quiesced===nonce;
  if(this.http||this.jobs.size)return false;
  this.quiesced=nonce;return true;
 }
 resume(nonce){
  if(this.quiesced&&this.quiesced!==nonce)return false;
  this.quiesced=null;return true;
 }
}
