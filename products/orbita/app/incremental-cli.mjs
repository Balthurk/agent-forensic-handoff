import fs from 'node:fs';import path from 'node:path';
import {DATA} from './corpus.mjs';import {registerCapture,captureOnce,captureStatus} from './capture.mjs';import {runPipeline,pipelineStatus} from './pipeline.mjs';import {saveTurn} from './turns.mjs';import {publishPending} from './publication.mjs';import {knowledgeOperation,extractKnowledge} from './knowledge.mjs';import {generationStatus,generationRequest} from './retained-generation.mjs';import {registerStore,listStores,federatedRetrieve} from './federation.mjs';import {closeMemory} from './memory.mjs';
const controller=new AbortController();for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>controller.abort(new Error('CALLER_CANCELLED')));
import {learningOperation,learningSources} from './learning.mjs';
import {decisionOperation,decisionSources} from './decisions.mjs';
import {reevaluationOperation} from './reevaluation.mjs';
try{const request=JSON.parse(fs.readFileSync(0,'utf8'));const b=request.input??{};let result;
 switch(request.op){
 case 'reevaluation.watch':case 'reevaluation.scan':case 'reevaluation.status':case 'reevaluation.run':case 'reevaluation.drain':result=await reevaluationOperation(request.op.slice(13),b,{signal:controller.signal});break;
 case 'learning.sources':result=await learningSources(b.conversationIds,{signal:controller.signal});break;
 case 'decision.sources':result=await decisionSources(b.conversationIds,{signal:controller.signal});break;
 case 'decision.frame':case 'decision.act':case 'decision.list':case 'decision.get':case 'decision.history':result=await decisionOperation(request.op.slice(9),b,{signal:controller.signal});break;
 case 'learning.record':case 'learning.query':case 'learning.get':case 'learning.history':result=await learningOperation(request.op.slice(9),b,{signal:controller.signal});break;
 case 'capture.register':result=registerCapture(b.source,b.allowPaths);break;
 case 'capture.run':result=await captureOnce(b.id,b.allowPaths,b.options);break;
 case 'capture.status':result=captureStatus();break;
 case 'pipeline.run':result=await runPipeline({...b,signal:controller.signal});break;
 case 'pipeline.status':result=pipelineStatus();break;
 case 'turn.save':result=await saveTurn(b);break;
 case 'publication.run':result=await publishPending(b.conversationIds,{signal:controller.signal});break;
 case 'publication.query':result=await knowledgeOperation('publication_query',b.conversationIds,{question:b.question},{signal:controller.signal});break;
 case 'generation.status':result=generationStatus(path.join(DATA,'semantic-extractions'));break;
 case 'generation.replay':result=await extractKnowledge({...generationRequest(path.join(DATA,'semantic-extractions'),b.id),requestId:b.id,signal:controller.signal});break;
 case 'store.register':result=registerStore(b);break;
 case 'store.list':result=listStores();break;
 case 'federation.query':result=await federatedRetrieve({...b,signal:controller.signal});break;
 default:throw new Error('UNKNOWN_INCREMENTAL_OPERATION');
 }
 controller.signal.throwIfAborted();process.stdout.write(JSON.stringify({ok:true,result})+'\n');
}catch(e){process.stdout.write(JSON.stringify({ok:false,error:e.message})+'\n');process.exitCode=1;}finally{await closeMemory();}
