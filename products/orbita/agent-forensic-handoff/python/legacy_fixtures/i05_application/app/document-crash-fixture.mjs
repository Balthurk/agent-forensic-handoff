import fs from 'node:fs';import path from 'node:path';
import {importDocument,reconcileDocuments} from './documents.mjs';import {createCorpusPlan,runCorpusPlan,corpusPlanStatus} from './corpus-plan.mjs';import {DATA,getLibrary,getEvidence} from './corpus.mjs';import {retrievePackage,closeMemory} from './memory.mjs';import {draftForInput} from './corpus-plan-fixture.mjs';
try{const mode=process.argv[2];let result;
 if(mode==='import')result=await importDocument({documentId:'crash-policy',filename:'crash.md',content:'No se permite aplicar la regla sin revisión expresa.'});
 else if(mode==='plan')result=await createCorpusPlan();
 else if(mode==='run'){const p=await createCorpusPlan();result=await runCorpusPlan({id:p.id,enableProposals:true},{inferDraft:async prompt=>{fs.appendFileSync(path.join(DATA,'provider-calls.txt'),'call\n');if(process.env.DOC_TEST_LOST==='1')throw new Error('MODEL_RESPONSE_LOST');return {value:draftForInput(prompt),model:'gpt-6.1-sol',modelObserved:'fixture',usage:null,receipt:'controlled'};}});}
 else{reconcileDocuments();const list=await getLibrary(),packet=await retrievePackage('sin revisión expresa',list.map(i=>i.id),{mode:'lexical'});const original=await getEvidence(packet.evidence[0].conversationId,packet.evidence[0].id);result={library:list,packet,original};}
 console.log(JSON.stringify(result));
}catch(e){console.error(e.message);process.exitCode=1;}finally{await closeMemory();}
