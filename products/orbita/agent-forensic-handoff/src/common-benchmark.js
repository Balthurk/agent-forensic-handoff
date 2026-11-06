import path from 'node:path';
import {randomUUID} from 'node:crypto';
import fs from './common-files.js';
import {walkFiles} from './common-util.js';
import {DatabaseSync,commonWorkerConfiguration,objectOperation} from './common-store.js';

export function benchmarkLocations(options,name){
  if(!options.output)throw new Error('Benchmark requires an explicit native --out export directory');
  const root=path.resolve(options.output);
  const caseRoot=options.caseRoot||(process.env.AFH_COSMOS_DATA&&path.join(process.env.AFH_COSMOS_DATA,'benchmarks',name+'-'+randomUUID()));
  if(!caseRoot)throw new Error('Benchmark requires a common caseRoot or AFH_COSMOS_DATA');
  const resolved=path.resolve(caseRoot),binding=commonWorkerConfiguration(resolved).bindings[0].root;
  const contains=(a,b)=>{const relative=path.relative(a,b);return !relative||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
  if(contains(binding,root)||contains(root,binding))throw new Error('Benchmark native inputs/exports must be separate from the common root');
  return {root,caseRoot:resolved};
}

export function logicalDirectoryBytes(root){
  let bytes=0;
  for(const file of walkFiles(root)){
    const stat=fs.statSync(file);
    if(stat.kind==='store'){
      const {info}=objectOperation('describe-store',file,{readOnly:true});
      const db=new DatabaseSync(file,{family:info.family,readOnly:true});
      try{bytes+=db.logicalManifest().typedBytes;}finally{db.close();}
    }else bytes+=stat.size;
  }
  return bytes;
}
