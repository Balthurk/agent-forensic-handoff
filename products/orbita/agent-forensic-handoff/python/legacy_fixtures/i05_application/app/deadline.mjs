import {setImmediate as yieldImmediate} from 'node:timers/promises';
export class RequestDeadline {
 constructor(milliseconds=30000,external){if(!Number.isFinite(milliseconds)||milliseconds<1||milliseconds>300000)throw new Error('DEADLINE_RANGE');this.started=performance.now();this.expires=this.started+milliseconds;this.controller=new AbortController();this.signal=this.controller.signal;this.onAbort=()=>this.controller.abort(external.reason??new Error('CALLER_CANCELLED'));this.external=external;external?.addEventListener('abort',this.onAbort,{once:true});if(external?.aborted)this.onAbort();this.timer=setTimeout(()=>this.controller.abort(new Error('DEADLINE_EXCEEDED')),milliseconds);this.timer.unref();}
 remaining(){return Math.max(0,this.expires-performance.now());}
 check(){if(this.remaining()<=0&&!this.signal.aborted)this.controller.abort(new Error('DEADLINE_EXCEEDED'));this.signal.throwIfAborted();}
 async yield(){await yieldImmediate();this.check();}
 close(){clearTimeout(this.timer);this.external?.removeEventListener('abort',this.onAbort);}
}
export async function cancellationPoint(signal){await yieldImmediate();signal?.throwIfAborted();}
