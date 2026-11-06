"""N06 decision cases composed over AFH's append-only N04 records.

Adapted contract: Noetis DecisionCases/DecisionBindings; no runtime imports.
Literal evidence supports traceability, not inferred truth, identity or causality.
"""
import copy, hashlib, json, re
from .knowledge_records import RecordError, _identifier, _json, _text
from .relational_memory import instant
from .learning import packet_bytes

SCHEMA='afh.decision-case.v1'
POLICY=dict(humanAcceptance=False,executionAuthority=False,causality='not_inferred',
            identityBasis='local_declaration_not_authenticated',semanticSupport='not_reviewed')
ACTIONS=('choose','defer','reject','reopen','result')

def require(ok,code):
    if not ok:raise RecordError(code)

def rid(scope,case_id):
    return 'decision-'+hashlib.sha256(_json([scope,_identifier(case_id)]).encode()).hexdigest()[:48]

def reference(record):
    return dict(caseId=record['payload']['decision_case']['id'],version=record['version'],
                digest=hashlib.sha256(_json(record).encode()).hexdigest())

def comparisons(case):
    options=[]
    for alt in case['alternatives']:
        statuses={alt['assessments'][c['id']]['status'] for c in case['constraints']}
        eligibility='excluded' if 'fail' in statuses else ('needs_evidence' if 'unknown' in statuses else 'eligible')
        options.append(dict(id=alt['id'],title=alt['title'],eligibility=eligibility,
                            assessments={k:v['status'] for k,v in alt['assessments'].items()}))
    return options

def public(record):
    d=record['payload']['decision_case'];options=comparisons(d['case']);eligible=sum(a['eligibility']=='eligible' for a in options)
    return dict(reference=reference(record),record=record,brief=dict(status=d['status'],selected=d['choice'],
        alternatives=options,disposition='compare' if eligible>1 else ('candidate_for_human_choice' if eligible else 'abstain'),
        choiceBinding=d['choiceBinding'],outcome=d['outcome'],
        limits=['Declared assessments only; literal support is not semantic validation.',
                'No automatic choice, weights, inferred causality or execution permission.',
                'Local operator declarations are not authenticated human acceptance.']))

def compile_event(records,case_id,action,detail,previous):
    from .host import ref
    scope=records.memory.scope;_identifier(case_id)
    require(action=='frame' or action in ACTIONS,'INVALID_ACTION')
    require(isinstance(detail,dict),'INVALID_DETAIL')
    require(len(_json(detail).encode())<=60000,'DECISION_INPUT_BUDGET')
    detail=copy.deepcopy(detail);_text(detail.get('actor'),'actor',128);_text(detail.get('statement'),'statement',2000)
    old=previous['payload']['decision_case'] if previous else None
    bindings={};refs={}
    def witnesses(items,key,user=False):
        require(isinstance(items,list) and 1<=len(items)<=8,'DECISION_EVIDENCE_REQUIRED:'+key)
        values=[]
        for item in items:
            require(isinstance(item,dict),'DECISION_EVIDENCE_INVALID')
            r=ref(records.memory,item.get('sourceId'),item.get('quote'),item.get('start'))
            e=records._source(r,scope)
            if user:require(e['role']=='user','USER_DECLARATION_REQUIRED')
            refs[r['id']]=dict(id=r['id'],revision=r['revision'])
            values.append({**r,'sourceRole':e['role'],'sourceConversationId':e['source_conversation_id'],
                           'occurrenceId':e['occurrence_id'],'support':'literal_quote_only'})
        bindings[key]=values
    def claim(value,key):
        require(isinstance(value,dict),'DECISION_CLAIM_REQUIRED:'+key)
        _text(value.get('text'),key,4000);witnesses(value.get('evidence'),key)
    def claims(values,key,maximum=12):
        require(isinstance(values,list) and len(values)<=maximum,'INVALID_LIST:'+key)
        for i,v in enumerate(values):claim(v,key+'/'+str(i))
    if action=='frame':
        require(detail.get('actorKind') in ('agent','local_operator'),'INVALID_ACTOR_KIND')
        require(old is None or old['status'] in ('pending_choice','deferred','rejected'),'REOPEN_REQUIRED')
        case=detail.get('case');require(isinstance(case,dict),'INVALID_CASE')
        if old:require(not(set(old['case'])-set(case)),'DECISION_FIELDS_REMOVED')
        status='pending_choice';choice=None;choice_binding=None;outcome=None
    else:
        require(old is not None,'CASE_NOT_FOUND');case=copy.deepcopy(old['case'])
        require(detail.get('actorKind')=='local_operator','OPERATOR_REQUIRED')
        witnesses(detail.get('evidence'),'declaration',user=True)
        status=old['status'];choice=old['choice'];choice_binding=old['choiceBinding'];outcome=old['outcome']
        if action=='choose':
            require(status in ('pending_choice','deferred','rejected'),'REOPEN_REQUIRED')
            choice=detail.get('alternativeId')
            require(choice in [o['id'] for o in comparisons(case) if o['eligibility']=='eligible'],'ALTERNATIVE_NOT_ELIGIBLE')
            status='chosen';choice_binding=None;outcome=None
        elif action=='result':
            require(status=='chosen','CHOICE_REQUIRED')
            expected=reference(previous)
            require(detail.get('choiceBinding')==expected,'RESULT_CHOICE_BINDING')
            claim(detail.get('observed'),'observed')
            status='result_recorded';choice_binding=expected
            outcome=dict(observed=copy.deepcopy(detail['observed']),choiceBinding=expected,
                         alternativeId=choice,attribution='operator_report_not_causal_proof')
        elif action=='reopen':
            require(status!='pending_choice','ALREADY_OPEN')
            status='pending_choice';choice=None;choice_binding=None;outcome=None
        else:
            require(status in ('pending_choice','deferred','rejected'),'REOPEN_REQUIRED')
            status='deferred' if action=='defer' else 'rejected';choice=None;choice_binding=None;outcome=None
    require(not set(case).intersection({'choice','selected','human_acceptance','weights','score',*POLICY}),'DECISION_SEPARATE')
    _text(case.get('title'),'title',500)
    for key in ('objective','expected_result','review_condition'):claim(case.get(key),key)
    constraints=case.get('constraints');criteria=case.get('criteria',[])
    require(isinstance(constraints,list) and 1<=len(constraints)<=12,'CONSTRAINTS_REQUIRED')
    claims(constraints,'constraints');claims(criteria,'criteria')
    keys=[]
    for value in constraints+criteria:keys.append(_identifier(value.get('id')))
    require(len(keys)==len(set(keys)),'DUPLICATE_CRITERION')
    alts=case.get('alternatives');require(isinstance(alts,list) and 2<=len(alts)<=10,'ALTERNATIVES_REQUIRED')
    ids=[]
    for i,alt in enumerate(alts):
        require(isinstance(alt,dict),'INVALID_ALTERNATIVE');ids.append(_identifier(alt.get('id')))
        _text(alt.get('title'),'alternative.title',500);claim(alt.get('mechanism'),'alternatives/'+str(i)+'/mechanism')
        assessments=alt.get('assessments');require(isinstance(assessments,dict) and set(assessments)==set(keys),'ASSESSMENTS_REQUIRED')
        for k,v in assessments.items():
            require(isinstance(v,dict) and v.get('status') in ('pass','fail','unknown'),'INVALID_ASSESSMENT')
            claim(v.get('reason'),'alternatives/'+str(i)+'/assessments/'+k)
    require(len(ids)==len(set(ids)),'DUPLICATE_ALTERNATIVE')
    for key in ('assumptions','information_gaps'):claims(case.get(key),key)
    require(len(refs)<=20,'DECISION_SOURCE_BUDGET')
    d=dict(schema=SCHEMA,id=case_id,action=action,detail=detail,case=case,status=status,choice=choice,
           choiceBinding=choice_binding,outcome=outcome,previous=reference(previous) if previous else None,
           bindings=bindings,originConversations=sorted({w['sourceConversationId'] for ws in bindings.values() for w in ws}),**POLICY)
    return dict(id=rid(scope,case_id),scope=scope,type='decision_case',text=case['title'],
                actor=dict(id=detail['actor'],role='agent' if detail['actorKind']=='agent' else 'user'),
                modality='stated',status='proposed',source_refs=[refs[k] for k in sorted(refs)],decision_case=d)

def structural(record,previous):
    p=record['payload'];d=p.get('decision_case')
    require(record['integrity']=='envelope_v1','DECISION_ENVELOPE_REQUIRED')
    require(isinstance(d,dict) and d.get('schema')==SCHEMA and all(d.get(k)==v for k,v in POLICY.items()),'DECISION_RECORD_SCHEMA')
    require(record['id']==rid(p['scope'],d['id']),'DECISION_ID_BINDING')
    require(record['version']==(previous['version']+1 if previous else 1),'DECISION_CHAIN_GAP')
    require(d.get('previous')==(reference(previous) if previous else None),'DECISION_CHAIN_BINDING')

def verify_chain(records,rows,*,verify_sources=True):
    previous=None;result=[]
    for row in rows:
        r=records._envelope(row,verify_sources=verify_sources);structural(r,previous)
        if verify_sources:
            d=r['payload']['decision_case']
            expected=compile_event(records,d['id'],d['action'],d['detail'],previous)
            require(r['payload']==expected,'DECISION_RECORD_BINDING')
        result.append(r);previous=r
    return result

def history_rows(records,scope,case_id):
    rows=records.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? AND record_id=? ORDER BY version LIMIT 501',(scope,rid(scope,case_id))).fetchall()
    require(len(rows)<=500,'DECISION_HISTORY_BUDGET');return rows

def dispatch_decision(records,request):
    op=request['op'];scope=records.memory.scope
    if op in ('decision_frame','decision_act'):
        case_id=request.get('id');_identifier(case_id);version=request.get('expectedVersion',0)
        require(type(version) is int and version>=0,'INVALID_VERSION')
        # All inherited history is validated, including retries after successors.
        history=verify_chain(records,history_rows(records,scope,case_id))
        previous=next((r for r in history if r['version']==version),None)
        require(version==0 or previous is not None,'VERSION_CONFLICT')
        require(len(history)<500 or any(r['version']==version+1 for r in history),'DECISION_HISTORY_BUDGET')
        if version:require(request.get('binding')==reference(previous),'BRIEF_BINDING_STALE')
        action='frame' if op=='decision_frame' else request.get('action')
        require(op=='decision_frame' or action in ACTIONS,'INVALID_ACTION')
        detail=dict(case=request.get('case'),actor=request.get('actor','local-editor'),actorKind=request.get('actorKind','agent'),statement=request.get('statement')) if action=='frame' else request.get('detail')
        payload=compile_event(records,case_id,action,detail,previous)
        # N04 serializes writers and binds exact retry payload + expected version.
        record=records.put(payload,expected_version=version,request_id=request.get('requestId'))
        return public(record)
    if op in ('decision_get','decision_history'):
        records.db.execute('BEGIN')
        history=verify_chain(records,history_rows(records,scope,request.get('id')))
        require(bool(history),'CASE_NOT_FOUND')
        if op=='decision_history':
            values=[public(r) for r in history]
            require(len(_json(values).encode())<=8_000_000,'DECISION_HISTORY_RESPONSE_BUDGET');return values
        version=request.get('version')
        require(version is None or (type(version) is int and version>0),'INVALID_VERSION')
        record=next((r for r in history if r['version']==version),None) if version is not None else history[-1]
        require(record is not None,'VERSION_NOT_FOUND');return public(record)
    require(op=='decision_list','UNKNOWN_DECISION_OPERATION')
    question=request.get('question','');require(isinstance(question,str) and len(question)<=8000,'INVALID_QUESTION')
    limit=request.get('limit',20);require(type(limit) is int and 1<=limit<=50,'DECISION_LIMIT')
    maximum=request.get('maxBytes',100000);require(type(maximum) is int and 4096<=maximum<=100000,'DECISION_PACKET_BUDGET')
    known=request.get('knownAt')
    if known is not None:instant(known)
    records.db.execute('BEGIN')
    rows=records.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? ORDER BY record_id,version LIMIT 2001',(scope,)).fetchall()
    require(len(rows)<=2000,'DECISION_ARCHIVE_BUDGET')
    grouped={}
    for row in rows:grouped.setdefault(row['record_id'],[]).append(row)
    errors=[];outside=0;matches=[];tokens=set(re.findall(r'\w+',question.casefold()))
    for key,group in grouped.items():
        try:
            chain=verify_chain(records,group,verify_sources=False)
            cut=[r for r in chain if known is None or instant(r['recorded_at'])<=instant(known)]
            if not cut:continue
            if any(not records.memory.source_eligible(s['id'],scope) for r in cut for s in r['payload']['source_refs']):outside+=1;continue
            verified=verify_chain(records,group[:len(cut)])[-1]
            def text_fields(value):
                if isinstance(value,dict):
                    for k,v in value.items():
                        if k in ('text','title','statement') and isinstance(v,str):yield v
                        elif isinstance(v,(dict,list)):yield from text_fields(v)
                elif isinstance(value,list):
                    for v in value:yield from text_fields(v)
            words=set(re.findall(r'\w+',' '.join(text_fields(verified['payload']['decision_case'])).casefold()))
            if not tokens or tokens.intersection(words):matches.append(public(verified))
        except (RecordError,ValueError,KeyError,TypeError) as error:errors.append(dict(recordId=key,error=str(error)))
    packet=dict(schema='afh.decision-list.v1',scope=scope,question=question,knownAt=known,items=[],errors=errors,
                matches=len(matches),outsideSelection=outside,omittedByLimit=max(0,len(matches)-limit),omittedByBudget=0,
                maxBytes=maximum,status='incomplete' if errors else 'no_cases_found',
                coverage='Selected source-backed cases; literal term filter only; missing results do not prove absence.')
    if not errors:
        for item in matches[:limit]:
            packet['items'].append(item)
            if packet_bytes(packet)>maximum:packet['items'].pop();packet['omittedByBudget']+=1
        packet['status']='cases_found' if packet['items'] else ('omitted' if matches else 'no_cases_found')
        if outside:packet['status']='partial_selection'
    require(packet_bytes(packet)<=maximum,'DECISION_PACKET_BUDGET');return packet
