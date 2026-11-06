import path from 'node:path';
import {CaseDatabase} from './database.js';
import {transactionIO} from './common-transaction.js';
import {assertPreAppendIntegrity} from './bitemporal-graph.js';
import {publishCaseManifest} from './case-seal.js';
import {renderCase} from './render.js';

export async function rehydrateCase(caseDir,{tokenBudget,_checkpoint=()=>{}}={}){
  const root=path.resolve(caseDir),db=new CaseDatabase(path.join(root,'case.pgstore'),{create:false});
  try{
    db.beginConsistentWrite();
    const {manifest}=assertPreAppendIntegrity(db,root);
    const result=await renderCase(db,root,manifest,{tokenBudget,output:transactionIO(db)});
    _checkpoint('after-render');
    publishCaseManifest(db,root,manifest);_checkpoint('after-seal');
    db.commit();_checkpoint('after-commit');return result;
  }catch(error){db.rollback();throw error;}
  finally{db.close();}
}
