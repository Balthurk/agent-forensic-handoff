import fs from 'node:fs';import path from 'node:path';
import {DATA,addSource} from './corpus.mjs';import {knowledgeOperation as knowledge,verifiedSources} from './knowledge.mjs';import {decisionOperation,decisionSources} from './decisions.mjs';import {learningOperation} from './learning.mjs';import {publishPending} from './publication.mjs';import {registerWatch,reevaluationStatus,runReevaluation,drainReevaluations,pauseAutomaticReevaluations} from './reevaluation.mjs';
import {userText,resultText,exportConversation,decisionFixture,actionFixture} from './decision-fixture.mjs';import {conversation,original,late,draft,reviewOutput} from './reevaluation-fixture.mjs';import {retrievePackage,closeMemory} from './memory.mjs';
const file=path.join(DATA,'recovery-scenario.json'),op=process.argv[2];
try{
 if(op==='seed'){
  pauseAutomaticReevaluations(true);
  const a=await addSource(exportConversation('choice',userText)),b=await addSource(exportConversation('result',resultText,'tool')),ids=[a.id,b.id],sources=await decisionSources(ids);
  const first=await decisionOperation('frame',{conversationIds:ids,id:'backup',case:decisionFixture(sources),actor:'fixture',statement:'Two options',requestId:'frame'});
  const chosen=await decisionOperation('act',{conversationIds:ids,id:'backup',action:'choose',detail:actionFixture(sources),expectedVersion:1,binding:first.reference,requestId:'choose'});
  await decisionOperation('act',{conversationIds:ids,id:'backup',action:'result',detail:{...actionFixture(sources,'result'),choiceBinding:chosen.reference},expectedVersion:2,binding:chosen.reference,requestId:'result'});
  const claim={text:'Restauración verificada en muestra',evidence:[{sourceId:sources.find(s=>s.text===resultText).id,quote:'La prueba local restauró doce archivos con hashes idénticos'}]};
  await learningOperation('record',{conversationIds:ids,requestId:'learning',episode:{id:'restore',title:'Restauración local',condition:claim,action:claim,observation:claim,outcome:{value:'success',evidence:claim.evidence},counterexamples:[]}});
  const c=await addSource(conversation('original',original)),context=await verifiedSources([c.id]);
  const record=(await knowledge('extract',[c.id],{draft:draft(context.sources[0]),producer:'fixture',sourceCut:context.cut,requestId:'semantic'})).records[0];
  await publishPending([c.id]);await registerWatch({id:record.id,expectedVersion:1,conversationIds:[c.id],terms:['refería'],automatic:true});
  const d=await addSource(conversation('late',late));fs.writeFileSync(file,JSON.stringify({decisionIds:ids,semanticIds:[c.id,d.id],recordId:record.id}));
 }
 const scenario=JSON.parse(fs.readFileSync(file,'utf8'));
 if(op==='resume'){
  let calls=0;const job=reevaluationStatus().jobs.find(j=>j.status==='pending');
  const inferReview=async prompt=>{calls++;return {value:reviewOutput(JSON.parse(prompt.split('\nPACKET\n')[1]),'changed'),modelObserved:'deterministic-fixture',receipt:'fixture-only'};};
  const first=await runReevaluation({id:job.id},{inferReview}),replay=await runReevaluation({id:job.id},{inferReview});console.log(JSON.stringify({calls,first,replay}));
 }else{
  const decisions=await decisionOperation('history',{conversationIds:scenario.decisionIds,id:'backup'}),learning=await learningOperation('history',{conversationIds:scenario.decisionIds,id:'restore'}),semantic=await knowledge('history',scenario.semanticIds,{id:scenario.recordId}),publication=await knowledge('publication_query',scenario.semanticIds,{question:'reunión'}),pending=reevaluationStatus();
  const retrieval=await retrievePackage('reunión',scenario.semanticIds,{mode:'lexical'}),paused=op==='probe'?await drainReevaluations():null;
  console.log(JSON.stringify({decisions,learning,semantic,publication,pending,evidence:retrieval.evidence,paused}));
 }
}finally{await closeMemory();}
