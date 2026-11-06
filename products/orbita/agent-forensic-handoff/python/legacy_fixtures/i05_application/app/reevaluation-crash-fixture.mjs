import fs from 'node:fs';import path from 'node:path';
import {conversation,original,late,draft,reviewOutput} from './reevaluation-fixture.mjs';
import {DATA,addSource} from './corpus.mjs';import {knowledgeOperation,verifiedSources} from './knowledge.mjs';import {registerWatch,reevaluationStatus,runReevaluation,scanReevaluations} from './reevaluation.mjs';
const mode=process.argv[2];
try{
 if(mode==='arrival'){await addSource(conversation('late',late));}
 else if(mode==='scan'){console.log(JSON.stringify(await scanReevaluations()));}
 else if(mode==='status'){console.log(JSON.stringify(reevaluationStatus()));}
 else if(['seed','seed-watch'].includes(mode)){
  const a=await addSource(conversation('old',original)),ids=[a.id],c=await verifiedSources(ids);const r=(await knowledgeOperation('extract',ids,{draft:draft(c.sources[0]),producer:'fixture',sourceCut:c.cut,requestId:'initial'})).records[0];
  await registerWatch({id:r.id,expectedVersion:1,conversationIds:ids,terms:['refería']});if(mode==='seed')await addSource(conversation('late',late));
  console.log(JSON.stringify({id:reevaluationStatus().jobs[0]?.id??null}));
 }else{
  const id=reevaluationStatus().jobs[0].id,counter=path.join(DATA,'model-calls.txt');
  const inferReview=async prompt=>{fs.appendFileSync(counter,'call\n');if(mode==='unknown')throw new Error('MODEL_RESPONSE_LOST');return {value:reviewOutput(JSON.parse(prompt.split('\nPACKET\n')[1])),modelObserved:'fixture',receipt:'fixture'};};
  const result=await runReevaluation({id},{inferReview});console.log(JSON.stringify(result));
 }
}catch(e){console.log(JSON.stringify({error:e.message}));process.exitCode=1;}
