"""F32: explicit ex ante reviews, conditional precedents and binary calibration.

No score changes authority. A favorable outcome is not a judgment of a decision.
Originals, N06 cases and F33 compositions retain their independent identities.
"""
import copy, math
from .knowledge_records import _identifier, _text, _json
from .collectives import require, digest, now, sql_cut
from .relational_memory import instant
from .retrospectives import evidence, exact as retrospective_exact
from .justifications import external, decision

SCHEMA='afh.decision-intelligence.v1'
KINDS=('review','precedent','forecast','outcome')
POLICY=dict(humanAcceptance=False,executionAuthority=False,automaticChoice=False,
            authorityScore=None,causality='not_inferred',truth='not_established',
            personalKnowledge='not_established',assessmentBasis='source_bound_local_declaration')
def rid(scope,key):return 'intelligence-'+digest([scope,_identifier(key)])[:48]
def reference(record):return dict(id=record['payload']['intelligence']['id'],version=record['version'],digest=digest(record))
def outcome_id(forecast_id):return 'outcome-'+digest(forecast_id)[:32]
def tick(records):
    records._intelligence_work=getattr(records,'_intelligence_work',0)+1
    require(records._intelligence_work<=4000,'INTELLIGENCE_WORK_BUDGET')

def compile_record(records,key,kind,detail,previous,frozen=None):
    tick(records);require(kind in KINDS,'INTELLIGENCE_KIND')
    require(isinstance(detail,dict) and len(_json(detail).encode())<=160000,'INTELLIGENCE_INPUT_BUDGET')
    d=copy.deepcopy(detail);common={'title','actor','reason','state'}
    fields=dict(review={'decision','context','decisionAt','judgment','criteria','assumptions','gaps'},
                precedent={'review','targetDecision','comparedAt','validUntil','scopeAssessment','comparisons','evidence'},
                forecast={'decision','context','probability','deadline','criterion','cohort','evidence'},
                outcome={'forecast','value','resolvedAt','evidence'})
    require(set(d)==common|fields[kind],'INTELLIGENCE_FIELDS')
    for k,n in [('title',400),('actor',128),('reason',2000)]:_text(d[k],k,n)
    require(d['state'] in ('active','withdrawn'),'INTELLIGENCE_STATE')
    if previous:require(previous['payload']['intelligence']['kind']==kind,'INTELLIGENCE_KIND_IMMUTABLE')
    bindings={};refs={};targets={}
    def witness(items,key_):
        bound=evidence(records,items);bindings[key_]=bound
        for r in bound:refs[r['id']]=dict(id=r['id'],revision=r['revision'])
        return bound
    def target(record):
        for r in record['payload']['source_refs']:refs[r['id']]=r
    if kind in ('review','forecast'):
        case=decision(records,d['decision']);context=external(records,'retrospectives',lambda r:retrospective_exact(r,d['context']))
        target(case);target(context);cv=case['payload']['decision_case'];rv=context['payload']['retrospective']
        targets=dict(decision=dict(reference=d['decision'],recordedAt=case['recorded_at'],case=cv['case'],status=cv['status'],choice=cv['choice']),
                     context=dict(reference=d['context'],recordedAt=context['recorded_at'],detail=rv['detail'],capture=rv['capture']))
        if kind=='review':
            instant(d['decisionAt']);require(d['judgment'] in ('adequate','concerns','uncertain'),'INTELLIGENCE_JUDGMENT')
            require(isinstance(d['criteria'],list) and 1<=len(d['criteria'])<=24,'INTELLIGENCE_CRITERIA')
            keys=set()
            for i,c in enumerate(d['criteria']):
                require(isinstance(c,dict) and set(c)=={'key','assessment','reason','evidence'},'INTELLIGENCE_CRITERION_FIELDS')
                require(c['key'] not in keys and c['assessment'] in ('pass','fail','unknown'),'INTELLIGENCE_CRITERION');keys.add(c['key'])
                _text(c['reason'],'criterion reason',2000);witness(c['evidence'],'criterion/'+str(i))
            require(keys=={c['id'] for c in cv['case']['constraints']+cv['case']['criteria']},'INTELLIGENCE_ALL_CRITERIA_REQUIRED')
            require(isinstance(d['assumptions'],list) and len(d['assumptions'])==len(cv['case']['assumptions']),'INTELLIGENCE_ALL_ASSUMPTIONS_REQUIRED')
            for i,a in enumerate(d['assumptions']):
                require(isinstance(a,dict) and set(a)=={'text','evidence'} and a['text']==cv['case']['assumptions'][i]['text'],'INTELLIGENCE_ASSUMPTION_BINDING')
                witness(a['evidence'],'assumption/'+str(i))
            require(isinstance(d['gaps'],list) and len(d['gaps'])<=20,'INTELLIGENCE_GAPS')
            for gap in d['gaps']:_text(gap,'gap',2000)
        else:
            p=d['probability'];require(type(p) in (int,float) and math.isfinite(p) and 0<=p<=1,'INTELLIGENCE_PROBABILITY')
            instant(d['deadline']);_text(d['criterion'],'criterion',4000);_text(d['cohort'],'cohort',128)
            witness(d['evidence'],'forecast')
            if previous:
                prior=previous['payload']['intelligence']['detail']
                require(all(d[k]==prior[k] for k in d if k not in ('state','actor','reason')),'INTELLIGENCE_FORECAST_IMMUTABLE')
    elif kind=='precedent':
        origin=exact(records,d['review'],'review');target_case=decision(records,d['targetDecision']);target(origin);target(target_case)
        od=origin['payload']['intelligence']['detail'];targets=dict(review=d['review'],targetDecision=d['targetDecision'],targetCase=target_case['payload']['decision_case']['case'],originDecision=od['decision'])
        instant(d['comparedAt']);instant(d['validUntil']);require(instant(d['comparedAt'])<instant(d['validUntil']),'INTELLIGENCE_INTERVAL')
        require(d['scopeAssessment'] in ('within','different','unknown'),'INTELLIGENCE_SCOPE_COMPARISON')
        bound=witness(d['evidence'],'comparison_scope')
        require(all(any(t[:10] in r['quote'] for r in bound) for t in (d['comparedAt'],d['validUntil'])),'INTELLIGENCE_COMPARISON_DATES_LITERAL')
        require(isinstance(d['comparisons'],list) and len(d['comparisons'])==len(od['assumptions']),'INTELLIGENCE_COMPARE_ALL_ASSUMPTIONS')
        for i,c in enumerate(d['comparisons']):
            require(isinstance(c,dict) and set(c)=={'assumption','assessment','reason','evidence'},'INTELLIGENCE_COMPARISON_FIELDS')
            require(c['assumption']==od['assumptions'][i]['text'] and c['assessment'] in ('matches','differs','unknown'),'INTELLIGENCE_COMPARISON')
            _text(c['reason'],'comparison reason',2000);witness(c['evidence'],'comparison/'+str(i))
    else:
        forecast=exact(records,d['forecast'],'forecast');target(forecast);fd=forecast['payload']['intelligence']['detail']
        require(d['forecast']['version']==1 and key==outcome_id(d['forecast']['id']),'INTELLIGENCE_OUTCOME_ID')
        require(d['value'] is None or type(d['value']) is bool,'INTELLIGENCE_BINARY_OUTCOME')
        instant(d['resolvedAt']);require(instant(d['resolvedAt'])>=instant(fd['deadline']),'INTELLIGENCE_OUTCOME_BEFORE_DEADLINE')
        witness(d['evidence'],'outcome');targets=dict(forecast=d['forecast'])
        if previous:require(d['forecast']==previous['payload']['intelligence']['detail']['forecast'],'INTELLIGENCE_FORECAST_BINDING_IMMUTABLE')
    require(len(refs)<=80,'INTELLIGENCE_SOURCE_BUDGET')
    if frozen is None:
        frozen=[dict(id=r['id'],revision=r['revision'],knownAt=records.memory.sources[r['id']].get('known_at')) for r in sorted(refs.values(),key=lambda r:r['id'])]
    require({(r['id'],r['revision']) for r in frozen}=={(r['id'],r['revision']) for r in refs.values()},'INTELLIGENCE_SOURCE_TIME_BINDING')
    for r in frozen:
        if r['knownAt'] is not None:instant(r['knownAt'])
    value=dict(schema=SCHEMA,id=key,kind=kind,detail=d,bindings=bindings,targets=targets,sourceTimes=frozen,previous=reference(previous) if previous else None,**POLICY)
    return dict(id=rid(records.memory.scope,key),scope=records.memory.scope,type='decision_'+kind,text=d['title'],actor=dict(id=d['actor'],role='user'),modality='stated',status='proposed',source_refs=[refs[k] for k in sorted(refs)],intelligence=value)

def history(records,key,known=None,version=None):
    _identifier(key)
    if known is not None:instant(known)
    if version is not None:require(type(version) is int and 1<=version<=100,'INTELLIGENCE_VERSION')
    cache=getattr(records,'_intelligence_cache',None)
    if cache is None:records._intelligence_cache={};cache=records._intelligence_cache
    token=(key,known,version)
    if token in cache:return cache[token]
    rows=records.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? AND record_id=? AND recorded_at<=? AND version<=? ORDER BY version LIMIT 101',(records.memory.scope,rid(records.memory.scope,key),sql_cut(known or '9999-01-01T00:00:00Z'),version or 100)).fetchall()
    require(len(rows)<=100,'INTELLIGENCE_HISTORY_BUDGET');chain=[]
    for row in rows:
        tick(records);record=records._envelope(row);v=record['payload'].get('intelligence',{})
        require(record['integrity']=='envelope_v1' and v.get('schema')==SCHEMA and v.get('id')==key,'INTELLIGENCE_SCHEMA')
        require(record['version']==len(chain)+1,'INTELLIGENCE_CHAIN_GAP')
        expected=compile_record(records,key,v['kind'],v['detail'],chain[-1] if chain else None,v['sourceTimes'])
        require(expected==record['payload'],'INTELLIGENCE_BINDING');chain.append(record)
    cache[token]=chain;return chain

def exact(records,binding,kind):
    require(isinstance(binding,dict) and set(binding)=={'id','version','digest'},'INTELLIGENCE_REFERENCE')
    chain=history(records,binding['id'],version=binding['version'])
    require(chain and reference(chain[-1])==binding and chain[-1]['payload']['intelligence']['kind']==kind,'INTELLIGENCE_REFERENCE_CHANGED')
    return chain[-1]

def latest_is(records,folder,binding,kind,known):
    if folder=='intelligence':return bool(history(records,binding['id'],known)) and reference(history(records,binding['id'],known)[-1])==binding
    def read(r):
        if folder=='decisions':
            from .decisions import rid as foreign_id
            key=foreign_id(r.memory.scope,binding['caseId'])
        else:
            from .retrospectives import rid as foreign_id
            key=foreign_id(r.memory.scope,binding['id'])
        v=r.db.execute('SELECT MAX(version) FROM record_versions WHERE scope=? AND record_id=? AND recorded_at<=?',(r.memory.scope,key,sql_cut(known))).fetchone()[0]
        return v==binding['version']
    return external(records,folder,read)

def public(records,record,known=None):
    known=known or now();v=record['payload']['intelligence'];d=v['detail'];kind=v['kind'];reasons=[]
    if d['state']=='withdrawn':reasons.append('withdrawn')
    if any(records.memory.sources[r['id']].get('document',{}).get('currentRevision') is False for r in record['payload']['source_refs']):reasons.append('historical_source_revision')
    item=dict(reference=reference(record),kind=kind,title=d['title'],record=record,sourceRefs=record['payload']['source_refs'],reasons=reasons,requiresReview=True,**POLICY)
    if kind in ('review','forecast'):
        if not latest_is(records,'decisions',d['decision'],None,known):reasons.append('decision_revision_changed')
        if not latest_is(records,'retrospectives',d['context'],None,known):reasons.append('context_revision_changed')
        t=v['targets'];rd=t['context']['detail']
        if rd['state']=='withdrawn':reasons.append('context_withdrawn')
        if kind=='review':
            at=instant(d['decisionAt']);late=[s['id'] for s in v['sourceTimes'] if s['knownAt'] is None or instant(s['knownAt'])>at]
            if late:reasons.append('evidence_not_known_by_decision_cut')
            if instant(t['decision']['recordedAt'])>at:reasons.append('decision_registered_after_declared_time')
            if instant(rd['subjectAt'])!=at or instant(rd['sourceCut'])>at:reasons.append('reconstruction_cut_mismatch')
            if t['decision']['choice'] is None:reasons.append('no_choice_recorded')
            if d['gaps'] or rd['gaps'] or t['decision']['case']['information_gaps']:reasons.append('unresolved_information_gaps')
            if any(c['assessment']=='unknown' for c in d['criteria']):reasons.append('criterion_unknown')
            if d['judgment']=='adequate' and any(c['assessment']=='fail' for c in d['criteria']):reasons.append('judgment_conflicts_with_failed_criterion')
            item.update(exAnteJudgment=d['judgment'],reviewTiming='retrospective' if instant(record['recorded_at'])>at else 'recorded_before_declared_decision',evidenceKnownByDecision=not late,
                        conclusion='abstain' if reasons or d['judgment']=='uncertain' else 'declared_review_only',outcomeInfluence='none')
        else:
            first=history(records,v['id'],version=1)[0];deadline=instant(d['deadline'])
            eligible=instant(first['recorded_at'])<deadline and all(s['knownAt'] is not None and instant(s['knownAt'])<=deadline for s in v['sourceTimes'])
            if not eligible:reasons.append('forecast_not_registered_before_deadline_with_known_sources')
            item.update(outcomeId=outcome_id(v['id']),probability=d['probability'],deadline=d['deadline'],cohort=d['cohort'],prospective=eligible,firstRecordedAt=first['recorded_at'])
    elif kind=='precedent':
        origin=exact(records,d['review'],'review');review=public(records,origin,known)
        if not latest_is(records,'intelligence',d['review'],None,known):reasons.append('review_revision_changed')
        if not latest_is(records,'decisions',d['targetDecision'],None,known):reasons.append('target_decision_revision_changed')
        if review['conclusion']=='abstain' or review['exAnteJudgment']!='adequate':reasons.append('origin_review_not_sufficient')
        if not instant(d['comparedAt'])<=instant(known)<instant(d['validUntil']):reasons.append('comparison_outside_interval')
        if d['scopeAssessment']!='within':reasons.append('scope_not_matched')
        if any(x['assessment']!='matches' for x in d['comparisons']):reasons.append('assumptions_not_matched')
        item.update(applicability='abstain' if reasons else 'candidate_for_human_review',originReview=review['reference'])
    else:item.update(observedOutcome=d['value'],resolvedAt=d['resolvedAt'])
    return item

def calibration(records,items,known,cohort):
    forecasts=[i for i in items if i['kind']=='forecast' and (not cohort or i['cohort']==cohort)];outcomes={i['record']['payload']['intelligence']['detail']['forecast']['id']:i for i in items if i['kind']=='outcome'}
    groups={}
    for f in forecasts:
        d=f['record']['payload']['intelligence']['detail'];event=digest([d['decision'],d['criterion'],d['deadline'],d['cohort']]);groups.setdefault(event,[]).append(f['reference']['id'])
    duplicates={i for g in groups.values() if len(g)>1 for i in g};samples=[];excluded=[]
    for f in forecasts:
        key=f['reference']['id'];o=outcomes.get(key);reasons=[r for r in f['reasons'] if r not in ('decision_revision_changed','context_revision_changed')]
        if key in duplicates:reasons.append('duplicate_event_predictions')
        if not o:reasons.append('outcome_unresolved_or_outside_selection')
        elif o['reasons'] or o['observedOutcome'] is None:reasons.extend(o['reasons'] or ['outcome_unknown'])
        elif instant(o['resolvedAt'])>instant(known):reasons.append('outcome_after_cut')
        if reasons:excluded.append(dict(forecast=f['reference'],title=f['title'],reasons=sorted(set(reasons))));continue
        p=f['probability'];y=int(o['observedOutcome']);samples.append(dict(forecast=f['reference'],outcome=o['reference'],probability=p,observed=y,brier=(p-y)**2))
    bins=[]
    for n in range(10):
        rows=[s for s in samples if min(9,int(s['probability']*10))==n]
        bins.append(dict(lower=n/10,upper=(n+1)/10,count=len(rows),meanProbability=sum(s['probability'] for s in rows)/len(rows) if rows else None,observedFrequency=sum(s['observed'] for s in rows)/len(rows) if rows else None))
    return dict(method='binary-brier-v1',formula='mean((probability - binary_outcome)^2)',cohort=cohort or 'all_selected_cohorts',n=len(samples),brier=sum(s['brier'] for s in samples)/len(samples) if samples else None,bins=bins,samples=samples,excluded=excluded,forecastCount=len(forecasts),interpretation='descriptive_only_not_decision_quality_or_authority',independence='not_established',populationCoverage='not_certified',**POLICY)

def query(records,request):
    from .context_retrieval import heads,words
    known=request.get('knownAt') or now();instant(known);view=request.get('view','all');require(view in ('all','calibration',*KINDS),'INTELLIGENCE_VIEW')
    question=request.get('question','');require(isinstance(question,str) and len(question)<=2000,'INTELLIGENCE_QUERY')
    cohort=request.get('cohort','');require(isinstance(cohort,str) and len(cohort)<=128,'INTELLIGENCE_COHORT')
    result=dict(schema='afh.decision-intelligence-query.v1',view=view,knownAt=known,items=[],outsideSelection=0,scanned=0,coverage='bounded_explicit_records_only',**POLICY)
    all_items=[]
    if records is not None:
        for row in heads(records,known,500):
            result['scanned']+=1;raw=records._envelope(row,verify_sources=False);v=raw['payload'].get('intelligence',{});require(v.get('schema')==SCHEMA,'INTELLIGENCE_SCHEMA')
            if any(not records.memory.source_eligible(r['id'],records.memory.scope) for r in raw['payload']['source_refs']):result['outsideSelection']+=1;continue
            record=history(records,v['id'],known)[-1];all_items.append(public(records,record,known))
    if view=='calibration':result['calibration']=calibration(records,all_items,known,cohort)
    cohort_forecasts={i['reference']['id'] for i in all_items if i['kind']=='forecast' and (not cohort or i['cohort']==cohort)}
    for item in all_items:
        if view not in ('all','calibration') and item['kind']!=view:continue
        if question.strip() and not words(question)&words(_json(item['record']['payload']['intelligence']['detail'])):continue
        if view=='calibration':
            if item['kind'] not in ('forecast','outcome'):continue
            forecast_id=item['reference']['id'] if item['kind']=='forecast' else item['record']['payload']['intelligence']['detail']['forecast']['id']
            if forecast_id not in cohort_forecasts:continue
        result['items'].append(item)
    result['requiresAbstention']=bool(result['outsideSelection']) or any(i['reasons'] for i in result['items']);return result

def dispatch_intelligence(records,request):
    if request['op']=='intelligence_query':
        if records is not None:records.db.execute('BEGIN')
        return query(records,request)
    require(records is not None,'INTELLIGENCE_STORE_UNAVAILABLE');key=_identifier(request.get('id'));op=request['op']
    if op=='intelligence_put':
        version=request.get('expectedVersion',0);require(type(version) is int and 0<=version<100,'INTELLIGENCE_VERSION')
        previous=next(iter(history(records,key,version=version)[-1:]),None) if version else None
        require(version==0 or previous is not None and reference(previous)==request.get('binding'),'INTELLIGENCE_BINDING_STALE')
        retry=records.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? AND record_id=? AND request_id=?',(records.memory.scope,rid(records.memory.scope,key),request.get('requestId'))).fetchone()
        frozen=records._envelope(retry)['payload']['intelligence']['sourceTimes'] if retry else None
        payload=compile_record(records,key,request.get('kind'),request.get('detail'),previous,frozen)
        d=payload['intelligence']['detail'];kind=payload['intelligence']['kind']
        if kind=='review':require(instant(d['decisionAt'])<=instant(now()),'INTELLIGENCE_FUTURE_DECISION')
        if kind=='outcome':require(instant(d['resolvedAt'])<=instant(now()),'INTELLIGENCE_FUTURE_OUTCOME')
        if kind=='precedent':require(instant(d['comparedAt'])<=instant(now()),'INTELLIGENCE_FUTURE_COMPARISON')
        record=records.put(payload,expected_version=version,request_id=request.get('requestId'));records._intelligence_cache={}
        return public(records,record)
    require(op in ('intelligence_get','intelligence_history'),'INTELLIGENCE_OPERATION');records.db.execute('BEGIN')
    chain=history(records,key,request.get('knownAt'),request.get('version'));require(chain,'INTELLIGENCE_NOT_AT_CUT')
    if request.get('version') is not None:require(chain[-1]['version']==request['version'],'INTELLIGENCE_NOT_AT_CUT')
    return [public(records,r,request.get('knownAt')) for r in chain] if op=='intelligence_history' else public(records,chain[-1],request.get('knownAt'))
