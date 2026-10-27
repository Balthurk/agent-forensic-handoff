"""F34: source-bound competing explanations, not a causal identification engine."""
import copy
from .knowledge_records import _identifier, _text, _json
from .collectives import require,digest,now,sql_cut
from .relational_memory import instant
from .retrospectives import evidence,exact as context_exact
from .justifications import external,decision
from .decision_intelligence import latest_is

SCHEMA='afh.causal-explanation.v1'
METHOD='explicit-competing-arguments-v1'
POLICY=dict(causality='not_established',truth='not_established',executionAuthority=False,humanAcceptance=False,
            automaticChoice=False,personalKnowledge='not_established',independence='not_established',coverage='explicit_arguments_only')
def rid(scope,key):return 'causal-'+digest([scope,_identifier(key)])[:48]
def reference(record):return dict(id=record['payload']['causal']['id'],version=record['version'],digest=digest(record))
def tick(records):
    records._causal_work=getattr(records,'_causal_work',0)+1
    require(records._causal_work<=4000,'CAUSAL_WORK_BUDGET')

def compile_record(records,key,detail,previous,frozen=None):
    tick(records);require(isinstance(detail,dict) and len(_json(detail).encode())<=180000,'CAUSAL_INPUT_BUDGET');d=copy.deepcopy(detail)
    require(set(d)=={'title','actor','reason','state','context','decision','effect','scope','hypotheses','gaps'},'CAUSAL_FIELDS')
    for k,n in [('title',400),('actor',128),('reason',2000)]:_text(d[k],k,n)
    require(d['state'] in ('active','withdrawn'),'CAUSAL_STATE')
    require(isinstance(d['gaps'],list) and len(d['gaps'])<=20,'CAUSAL_GAPS')
    for gap in d['gaps']:_text(gap,'gap',2000)
    refs={};bindings={}
    def witness(items,field):
        bound=evidence(records,items);bindings[field]=bound
        for r in bound:refs[r['id']]=dict(id=r['id'],revision=r['revision'])
        return bound
    ctx=external(records,'retrospectives',lambda r:context_exact(r,d['context']));targets=dict(context=ctx['payload']['retrospective']['detail'])
    for r in ctx['payload']['source_refs']:refs[r['id']]=r
    if d['decision'] is not None:
        case=decision(records,d['decision']);targets['decision']=case['payload']['decision_case']
        for r in case['payload']['source_refs']:refs[r['id']]=r
    e=d['effect'];require(isinstance(e,dict) and set(e)=={'text','evidence'},'CAUSAL_EFFECT');_text(e['text'],'effect',4000);witness(e['evidence'],'effect')
    s=d['scope'];require(isinstance(s,dict) and set(s)=={'text','validFrom','validUntil','evidence'},'CAUSAL_SCOPE');_text(s['text'],'scope',2000);bound=witness(s['evidence'],'scope')
    for name in ('validFrom','validUntil'):
        if s[name] is not None:
            instant(s[name]);require(any(s[name][:10] in r['quote'] for r in bound),'CAUSAL_SCOPE_DATE_NOT_LITERAL')
    if s['validFrom'] and s['validUntil']:require(instant(s['validFrom'])<instant(s['validUntil']),'CAUSAL_INTERVAL')
    require(isinstance(d['hypotheses'],list) and 1<=len(d['hypotheses'])<=12,'CAUSAL_HYPOTHESES');keys=set()
    for h in d['hypotheses']:
        require(isinstance(h,dict) and set(h)=={'key','text','kind','attributedTo','mechanism','method','evidence','assumptions','counterfactual'},'CAUSAL_HYPOTHESIS_FIELDS')
        k=_identifier(h['key']);require(k not in keys,'CAUSAL_DUPLICATE_HYPOTHESIS');keys.add(k);_text(h['text'],'hypothesis',4000)
        require(h['kind'] in ('hypothesis','attributed_reason'),'CAUSAL_KIND');require(h['method'] in ('unspecified','temporal_sequence','observational_comparison','intervention_report','attribution_only'),'CAUSAL_METHOD')
        if h['mechanism'] is not None:_text(h['mechanism'],'mechanism',4000)
        require(isinstance(h['evidence'],list) and 1<=len(h['evidence'])<=12,'CAUSAL_HYPOTHESIS_EVIDENCE');all_bound=[]
        for i,ev in enumerate(h['evidence']):
            require(isinstance(ev,dict) and set(ev)<= {'position','basis','sourceId','quote','start'} and {'position','basis','sourceId','quote'}<=set(ev),'CAUSAL_EVIDENCE_FIELDS')
            require(ev['position'] in ('supports','contradicts','uncertain') and ev['basis'] in ('observation','attribution','intervention','sequence'),'CAUSAL_EVIDENCE_KIND')
            all_bound.extend(witness([{x:v for x,v in ev.items() if x not in ('position','basis')}],'hypothesis/'+k+'/'+str(i)))
        if h['kind']=='attributed_reason':
            _text(h['attributedTo'],'attributedTo',300)
            require(any(ev['basis']=='attribution' and h['attributedTo'] in ev['quote'] for ev in h['evidence']),'CAUSAL_ATTRIBUTION_NOT_LITERAL')
        else:require(h['attributedTo'] is None,'CAUSAL_NO_IMPLICIT_ACTOR')
        require(isinstance(h['assumptions'],list) and len(h['assumptions'])<=12,'CAUSAL_ASSUMPTIONS');akeys=set()
        for i,a in enumerate(h['assumptions']):
            require(isinstance(a,dict) and set(a)=={'key','text','assessment','evidence'},'CAUSAL_ASSUMPTION_FIELDS')
            ak=_identifier(a['key']);require(ak not in akeys,'CAUSAL_DUPLICATE_ASSUMPTION');akeys.add(ak);_text(a['text'],'assumption',2000)
            require(a['assessment'] in ('supported','contradicted','unknown'),'CAUSAL_ASSESSMENT');witness(a['evidence'],'assumption/'+k+'/'+str(i))
        cf=h['counterfactual']
        if cf is not None:
            require(isinstance(cf,dict) and set(cf)=={'text','assessment','evidence'},'CAUSAL_COUNTERFACTUAL');_text(cf['text'],'counterfactual',4000)
            require(cf['assessment'] in ('supported','contradicted','unknown'),'CAUSAL_ASSESSMENT');witness(cf['evidence'],'counterfactual/'+k)
    require(len(refs)<=80,'CAUSAL_SOURCE_BUDGET')
    if frozen is None:frozen=[dict(id=r['id'],revision=r['revision'],knownAt=records.memory.sources[r['id']].get('known_at')) for r in sorted(refs.values(),key=lambda r:r['id'])]
    require({(r['id'],r['revision']) for r in frozen}=={(r['id'],r['revision']) for r in refs.values()},'CAUSAL_CAPTURE_REFS')
    for r in frozen:
        if r['knownAt'] is not None:instant(r['knownAt'])
    value=dict(schema=SCHEMA,id=key,method=METHOD,detail=d,bindings=bindings,targets=targets,sourceTimes=frozen,previous=reference(previous) if previous else None,**POLICY)
    return dict(id=rid(records.memory.scope,key),scope=records.memory.scope,type='causal_explanation',text=d['title'],actor=dict(id=d['actor'],role='user'),modality='stated',status='proposed',source_refs=[refs[k] for k in sorted(refs)],causal=value)

def history(records,key,known=None,version=None):
    _identifier(key)
    if known is not None:instant(known)
    if version is not None:require(type(version) is int and 1<=version<=100,'CAUSAL_VERSION')
    rows=records.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? AND record_id=? AND recorded_at<=? AND version<=? ORDER BY version LIMIT 101',(records.memory.scope,rid(records.memory.scope,key),sql_cut(known or '9999-01-01T00:00:00Z'),version or 100)).fetchall()
    require(len(rows)<=100,'CAUSAL_HISTORY_BUDGET');chain=[]
    for row in rows:
        tick(records);record=records._envelope(row);v=record['payload'].get('causal',{})
        require(record['integrity']=='envelope_v1' and v.get('schema')==SCHEMA and v.get('id')==key,'CAUSAL_SCHEMA');require(record['version']==len(chain)+1,'CAUSAL_CHAIN_GAP')
        expected=compile_record(records,key,v['detail'],chain[-1] if chain else None,v['sourceTimes']);require(expected==record['payload'],'CAUSAL_BINDING');chain.append(record)
    return chain

def public(records,record,known=None,valid=None):
    known=known or now();valid=valid or known;instant(known);instant(valid);v=record['payload']['causal'];d=v['detail'];reasons=[]
    if d['state']=='withdrawn':reasons.append('explanation_withdrawn')
    if not latest_is(records,'retrospectives',d['context'],None,known):reasons.append('context_revision_changed')
    if d['decision'] and not latest_is(records,'decisions',d['decision'],None,known):reasons.append('decision_revision_changed')
    ctx=v['targets']['context']
    if ctx['state']=='withdrawn':reasons.append('context_withdrawn')
    if any(c['position']!='supports' for c in ctx['claims']):reasons.append('context_adverse_or_uncertain')
    if ctx['gaps'] or d['gaps']:reasons.append('declared_gaps')
    if any(r['knownAt'] is None for r in v['sourceTimes']):reasons.append('source_acquisition_unknown')
    if any(r['knownAt'] and instant(r['knownAt'])>instant(ctx['sourceCut']) for r in v['sourceTimes']):reasons.append('evidence_after_context_cut')
    if any(records.memory.sources[r['id']].get('document',{}).get('currentRevision') is False for r in record['payload']['source_refs']):reasons.append('historical_source_revision')
    s=d['scope']
    if not s['validFrom'] or not s['validUntil']:reasons.append('validity_unknown')
    elif not instant(s['validFrom'])<=instant(valid)<instant(s['validUntil']):reasons.append('outside_validity')
    if len(d['hypotheses'])<2:reasons.append('alternative_explanations_missing')
    evaluations=[];groups={}
    for h in d['hypotheses']:
        why=[];positions={e['position'] for e in h['evidence']};support='supports' in positions;contrary='contradicts' in positions
        if not support:why.append('no_declared_support')
        if contrary:why.append('counterevidence_present')
        if 'uncertain' in positions:why.append('uncertain_evidence')
        if not h['mechanism']:why.append('mechanism_unknown')
        if h['kind']=='hypothesis':
            if h['method'] not in ('observational_comparison','intervention_report'):why.append('causal_method_insufficient')
            if h['method']=='intervention_report' and not any(e['basis']=='intervention' and e['position']=='supports' for e in h['evidence']):why.append('intervention_not_supported')
            if not any(e['basis'] in ('observation','intervention') and e['position']=='supports' for e in h['evidence']):why.append('sequence_or_attribution_only')
            if not h['assumptions'] or any(a['assessment']!='supported' for a in h['assumptions']):why.append('assumptions_unresolved')
            if h['counterfactual'] is None or h['counterfactual']['assessment']!='supported':why.append('counterfactual_unresolved')
        else:why.append('attribution_not_causal_identification')
        for e in h['evidence']:groups.setdefault(e['sourceId'],set()).add(h['key'])
        status='conflicting' if support and contrary else 'challenged' if contrary else 'pending' if why else 'argument_ready_for_review'
        evaluations.append(dict(key=h['key'],status=status,reasons=why,uniqueWitnesses=len({(e['sourceId'],e['quote']) for e in h['evidence']}),causality='not_established'))
    shared=[dict(sourceId=k,hypotheses=sorted(vals)) for k,vals in groups.items() if len(vals)>1]
    return dict(reference=reference(record),title=d['title'],record=record,sourceRefs=record['payload']['source_refs'],method=METHOD,reasons=reasons,hypotheses=evaluations,sharedSources=shared,selectedCause=None,
                reviewStatus='abstain' if reasons or any(h['status']!='argument_ready_for_review' for h in evaluations) else 'structured_arguments_for_review',requiresAbstention=True,requiresReview=True,**POLICY)

def query(records,request):
    from .context_retrieval import heads,words
    known=request.get('knownAt') or now();valid=request.get('validAt') or known;instant(known);instant(valid);question=request.get('question','')
    require(isinstance(question,str) and len(question)<=2000,'CAUSAL_QUERY')
    result=dict(schema='afh.causal-query.v1',knownAt=known,validAt=valid,items=[],outsideSelection=0,scanned=0,requiresAbstention=True,**POLICY)
    if records is None:return result
    for row in heads(records,known,500):
        result['scanned']+=1;raw=records._envelope(row,verify_sources=False);v=raw['payload'].get('causal',{});require(v.get('schema')==SCHEMA,'CAUSAL_SCHEMA')
        if any(not records.memory.source_eligible(r['id'],records.memory.scope) for r in raw['payload']['source_refs']):result['outsideSelection']+=1;continue
        item=public(records,history(records,v['id'],known)[-1],known,valid)
        if question.strip() and not terms_match(question,item):continue
        result['items'].append(item)
    return result
def terms_match(question,item):
    from .context_retrieval import words
    return bool(words(question)&words(_json(item['record']['payload']['causal']['detail'])))

def dispatch_causal(records,request):
    op=request['op']
    if op=='causal_query':
        if records is not None:records.db.execute('BEGIN')
        return query(records,request)
    require(records is not None,'CAUSAL_STORE_UNAVAILABLE');key=_identifier(request.get('id'))
    if op=='causal_put':
        ver=request.get('expectedVersion',0);require(type(ver) is int and 0<=ver<100,'CAUSAL_VERSION')
        chain=history(records,key,version=ver) if ver else [];previous=chain[-1] if chain else None
        require(ver==0 or previous is not None and reference(previous)==request.get('binding'),'CAUSAL_BINDING_STALE')
        retry=records.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? AND record_id=? AND request_id=?',(records.memory.scope,rid(records.memory.scope,key),request.get('requestId'))).fetchone()
        frozen=records._envelope(retry)['payload']['causal']['sourceTimes'] if retry else None
        return public(records,records.put(compile_record(records,key,request.get('detail'),previous,frozen),expected_version=ver,request_id=request.get('requestId')))
    require(op in ('causal_get','causal_history'),'CAUSAL_OPERATION');records.db.execute('BEGIN');chain=history(records,key,request.get('knownAt'),request.get('version'));require(chain,'CAUSAL_NOT_AT_CUT')
    if request.get('version') is not None:require(chain[-1]['version']==request['version'],'CAUSAL_NOT_AT_CUT')
    return [public(records,r,request.get('knownAt'),request.get('validAt')) for r in chain] if op=='causal_history' else public(records,chain[-1],request.get('knownAt'),request.get('validAt'))
