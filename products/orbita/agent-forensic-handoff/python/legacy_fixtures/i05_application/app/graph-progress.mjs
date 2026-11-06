// Only monotonically increasing receipts of completed remote graph work extend liveness.
export class GraphProgress {
 constructor(onProgress){this.onProgress=onProgress;this.pending='';this.sequence=0;}
 push(chunk){
  this.pending+=chunk.toString('utf8');
  if(this.pending.length>65536){this.pending='';return;}
  for(;;){const end=this.pending.indexOf('\n');if(end<0)break;const line=this.pending.slice(0,end);this.pending=this.pending.slice(end+1);
   if(!line.startsWith('ORBITA_G1_PROGRESS '))continue;
   try{const p=JSON.parse(line.slice(19));if(p.schema!==1||p.sequence!==this.sequence+1||!['objects','links','readback'].includes(p.stage)||!Number.isSafeInteger(p.completed)||p.completed<1)continue;
    this.sequence=p.sequence;this.onProgress(p);
   }catch{}
  }
 }
}
