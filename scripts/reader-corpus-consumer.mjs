import {assertReadObservation} from '../src/archive/reader-observation.js';
export function validateReaderCorpus(entries){
  const reject=message=>{throw Object.assign(new Error('Reader closure rejected: '+message),{code:'READ_CONTROL_REJECTED'});};
  const outcomes=[];for(const item of entries){
    const pairs=(item.r.requests??[]).filter(pair=>['evidence.read','archive.verify','scope.resolve','event.show','stats'].includes(pair.request.operation)),observations=item.r.read_only_observations??[];
    if(pairs.length!==observations.length)reject('Every accepted read requires exactly one observation');
    if(new Set(pairs.map(pair=>pair.request.request_id)).size!==pairs.length||new Set(observations.map(o=>o.request_id)).size!==observations.length)reject('Duplicate read identity');
    for(const observation of observations){const pair=pairs.find(pair=>pair.request.request_id===observation.request_id);if(!pair)reject('Orphan observation');outcomes.push(assertReadObservation({...pair,observation,expectation:observation.expectation??null,requireOutcome:true}));}
    for(const rejected of item.r.read_only_rejections??[])if(pairs.some(pair=>pair.request.request_id===rejected.request.request_id))reject('Rejected observation cannot also be accepted');
    const internal=item.r.internal_read_observations??[];
    if(new Set(internal.map(value=>value.request.request_id)).size!==internal.length)reject('Duplicate internal read identity');
    for(const value of internal){
      if(value.request.kind!=='INTERNAL_FUNCTION_CALL'||value.response.kind!=='INTERNAL_FUNCTION_RESULT'||value.request.operation!=='ledger.occurrences'||value.request.export!=='readOccurrenceGroups')reject('Internal observation must describe the exact function call, never a wire response');
      outcomes.push({...assertReadObservation({...value,expectation:value.observation.expectation??null,requireOutcome:true}),surface:'INTERNAL_FUNCTION'});
    }
  }return outcomes;
}
