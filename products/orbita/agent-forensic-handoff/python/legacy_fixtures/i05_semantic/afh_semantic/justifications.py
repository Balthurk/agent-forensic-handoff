"""Alternative, source-bound justifications for exact N06 decision versions.

Four-valued support is deliberately not a truth probability or approval.
Withdrawn/missing evidence is unknown, including under NOT. All/any/not share
the N04 condition AST operator/operands vocabulary; unknown operators persist.
"""
import copy, re
from pathlib import Path
from .knowledge_records import KnowledgeRecords, RecordError, _identifier, _json, _text
from .collectives import digest, now, sql_cut, temporal, validity, require, resolve_target
from .relational_memory import instant
from .learning import packet_bytes

POLICY=dict(humanAcceptance=False,executionAuthority=False,semanticSupport='declared_review_not_authenticated',automaticChoice=False)
STATES={'supported':(True,False),'refuted':(False,True),'conflicting':(True,True),'pending':(False,False)}
def state(pair):return next(k for k,v in STATES.items() if v==tuple(pair))
def record_id(scope,kind,key):return 'support-'+kind+'-'+digest([scope,key])[:48]
def reference(r):return dict(id=r['payload']['support']['id'],version=r['version'],digest=digest(r))

def exact(records,kind,key,version=None,known=None):
    require(version is None or type(version) is int and version>0,'INVALID_VERSION')
    query='SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? AND record_id=?';params=[records.memory.scope,record_id(records.memory.scope,kind,key)]
    if version is not None:query+=' AND version=?';params.append(version)
    if known is not None:query+=' AND recorded_at<=?';params.append(sql_cut(known))
    row=records.db.execute(query+' ORDER BY version DESC LIMIT 1',params).fetchone()
    if row is None:return None
    r=records._envelope(row);s=r['payload'].get('support')
    require(r['integrity']=='envelope_v1' and isinstance(s,dict) and s.get('kind')==kind and s.get('id')==key and s.get('schema')=='afh.support.v1','SUPPORT_BINDING')
    require(all(s.get(k)==v for k,v in POLICY.items()),'SUPPORT_POLICY')
    return r

def external(records,folder,callback):
    from .host import AFHMemory
    root=records.memory.path.parent.parent/folder
    require((root/'records.sqlite3').is_file(),'TARGET_NOT_FOUND')
    # Cross-store resolution only reads existing versions. Opening a writer
    # here can deadlock a caller holding the decision's read snapshot (F22).
    m=AFHMemory(root,list(records.memory.sources.values()),records.memory.scope);r=KnowledgeRecords(m,root/'records.sqlite3',read_only=True)
    try:return callback(r)
    finally:r.close();m.close()

def decision(records,binding,known=None):
    from .decisions import rid,verify_chain,reference as dref
    require(isinstance(binding,dict) and set(binding)=={'caseId','version','digest'} and type(binding['version']) is int and binding['version']>0,'DECISION_BINDING_REQUIRED')
    _identifier(binding['caseId'])
    def read(r):
        rows=r.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? AND record_id=? AND version<=? ORDER BY version LIMIT 501',(r.memory.scope,rid(r.memory.scope,binding['caseId']),binding['version'])).fetchall()
        require(len(rows)<=500,'DECISION_HISTORY_BUDGET');chain=verify_chain(r,rows);require(bool(chain) and dref(chain[-1])==binding,'DECISION_BINDING_STALE')
        target=chain[-1];require(known is None or instant(target['recorded_at'])<=instant(known),'DECISION_NOT_KNOWN_AT_CUT')
        return target
    return external(records,'decisions',read)

def target_refs(records,target):
    require(isinstance(target,dict),'TARGET_REQUIRED')
    if target.get('kind')=='justification':
        require(set(target)=={'kind','id','version','digest'},'TARGET_SHAPE')
        r=exact(records,'justification',target['id'],target['version']);require(r is not None and digest(r)==target['digest'],'TARGET_DIGEST_MISMATCH')
        return r['payload']['source_refs']
    if target.get('kind')=='collective':
        return external(records,'collectives',lambda r:resolve_target(r,target))
    return resolve_target(records,target)

def witnesses(records,values,field,refs):
    from .host import ref
    require(isinstance(values,list) and 1<=len(values)<=8,'SUPPORT_EVIDENCE_REQUIRED:'+field);out=[]
    for v in values:
        require(isinstance(v,dict),'INVALID_WITNESS');r=ref(records.memory,v.get('sourceId'),v.get('quote'),v.get('start'))
        s=records._source(r,records.memory.scope);refs[r['id']]=dict(id=r['id'],revision=r['revision'])
        out.append({**r,'sourceRole':s['role'],'occurrenceId':s['occurrence_id'],'support':'literal_quote_only'})
    return out

def validate_ast(node,ids,depth=0,counter=None):
    if counter is None:counter=[0]
    counter[0]+=1;require(depth<=12 and counter[0]<=120 and isinstance(node,dict),'SUPPORT_AST_BUDGET')
    if 'operator' in node:
        _text(node['operator'],'operator',80);args=node.get('operands');require(isinstance(args,list) and 1<=len(args)<=40,'SUPPORT_AST_OPERANDS')
        if node['operator']=='not':require(len(args)==1,'SUPPORT_AST_ARITY')
        if node['operator'] in ('all','any'):require(len(args)>=2,'SUPPORT_AST_ARITY')
        for child in args:validate_ast(child,ids,depth+1,counter)
    else:require(node.get('kind')=='requirement_ref' and node.get('requirementId') in ids,'SUPPORT_AST_REFERENCE')

def logic(node,values):
    if 'operator' not in node:return values[node['requirementId']]
    children=[logic(c,values) for c in node['operands']];op=node['operator']
    if op=='all':return all(x[0] for x in children),any(x[1] for x in children)
    if op=='any':return any(x[0] for x in children),all(x[1] for x in children)
    if op=='not':return children[0][1],children[0][0]
    return False,False

def compile_payload(records,kind,key,detail,previous):
    require(isinstance(detail,dict) and len(_json(detail).encode())<=60000,'SUPPORT_INPUT_BUDGET');detail=copy.deepcopy(detail);refs={};bindings={}
    for k,n in (('actor',128),('reason',2000)):_text(detail.get(k),k,n)
    bindings['review']=witnesses(records,detail.get('evidence'),'review',refs)
    if kind=='justification':
        require(set(detail)=={'decision','alternativeId','title','scope','state','requirements','logic','temporal','actor','reason','evidence'},'JUSTIFICATION_FIELDS')
        d=decision(records,detail['decision']);case=d['payload']['decision_case']['case']
        require(detail['alternativeId'] in [a['id'] for a in case['alternatives']],'ALTERNATIVE_NOT_FOUND')
        for r in d['payload']['source_refs']:refs[r['id']]=r
        _text(detail['title'],'title',500);_text(detail['scope'],'scope',2000);require(detail['state'] in ('active','withdrawn'),'SUPPORT_STATE')
        reqs=detail['requirements'];require(isinstance(reqs,list) and 1<=len(reqs)<=40,'SUPPORT_REQUIREMENTS')
        ids=[]
        for req in reqs:
            require(isinstance(req,dict) and set(req)=={'id','text','target','judgment','evidence'},'REQUIREMENT_FIELDS')
            ids.append(_identifier(req['id']));_text(req['text'],'requirement',2000);require(req['judgment'] in STATES,'SUPPORT_JUDGMENT')
            for r in target_refs(records,req['target']):refs[r['id']]=r
            bindings[req['id']]=witnesses(records,req['evidence'],req['id'],refs)
        require(len(ids)==len(set(ids)),'DUPLICATE_REQUIREMENT');validate_ast(detail['logic'],set(ids))
        temporal(detail['temporal'],lambda values,field:bindings.update({field:witnesses(records,values,field,refs)}))
        title=detail['title']
    else:
        require(kind=='impact' and set(detail)=={'target','judgment','actor','reason','evidence'},'IMPACT_FIELDS')
        require(detail['judgment'] in (*STATES,'withdrawn'),'SUPPORT_JUDGMENT')
        require(key==digest(detail['target']),'IMPACT_TARGET_BINDING')
        for r in target_refs(records,detail['target']):refs[r['id']]=r
        title='Revisión de evidencia: '+detail['judgment']
    require(len(refs)<=20,'SUPPORT_SOURCE_BUDGET')
    s=dict(schema='afh.support.v1',kind=kind,id=key,detail=detail,bindings=bindings,previous=reference(previous) if previous else None,**POLICY)
    return dict(id=record_id(records.memory.scope,kind,key),scope=records.memory.scope,type='decision_'+kind,text=title,
        actor=dict(id=detail['actor'],role='unknown'),modality='stated',status='proposed',source_refs=[refs[k] for k in sorted(refs)],support=s)

def history(records,kind,key,known=None):
    rows=records.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? AND record_id=? ORDER BY version LIMIT 101',(records.memory.scope,record_id(records.memory.scope,kind,key))).fetchall()
    if known is not None:rows=[r for r in rows if instant(r['recorded_at'])<=instant(known)]
    require(len(rows)<=100,'SUPPORT_HISTORY_BUDGET');out=[]
    for row in rows:
        r=records._envelope(row);require(r['version']==len(out)+1,'SUPPORT_CHAIN_GAP')
        s=r['payload'].get('support');require(isinstance(s,dict),'SUPPORT_SCHEMA')
        require(r['payload']==compile_payload(records,kind,key,s['detail'],out[-1] if out else None),'SUPPORT_RECORD_BINDING');out.append(r)
    return out

def source_changes(records,refs,valid_at,mode):
    reasons=[]
    for ref in refs:
        s=records._source(ref,records.memory.scope);doc=s.get('document',{})
        if mode=='current' and doc.get('currentRevision') is False:reasons.append('historical_document_revision:'+ref['id'])
        metadata=doc.get('metadata',{})
        for key,compare in (('validFrom',lambda a,b:a<b),('validUntil',lambda a,b:a>=b)):
            if metadata.get(key) and compare(instant(valid_at),instant(metadata[key])):reasons.append('document_outside_declared_interval:'+ref['id'])
    return reasons

def evaluate_one(records,r,known,at,mode,stack=(),meter=None):
    if meter is None:meter=[0]
    meter[0]+=1;require(meter[0]<=150,'SUPPORT_WORK_BUDGET')
    s=r['payload']['support'];key=s['id'];d=s['detail']
    if key in stack or len(stack)>=12:return dict(reference=reference(r),state='pending',reasons=['dependency_cycle_or_depth'],requirements=[])
    reasons=[];values={};items=[]
    v=validity(d['temporal'],at)
    if v!='within_declared_interval':reasons.append('validity_'+v)
    if d['state']=='withdrawn':reasons.append('justification_withdrawn')
    # Rationale/temporal witnesses apply to this justification as a whole.
    # Requirement evidence is evaluated per branch, so an unavailable branch
    # cannot erase a separate supported alternative under ANY.
    reasons+=source_changes(records,[w for k in ('review','temporal') for w in s['bindings'].get(k,[])],at,mode)
    for req in d['requirements']:
        rs=[];target=req['target'];target_key=digest(target);assessment=req['judgment'];impact=exact(records,'impact',target_key,known=known)
        if impact:
            # Validate the exact review event, including its quoted rationale.
            validated=history(records,'impact',target_key,known=known)[-1];assessment=validated['payload']['support']['detail']['judgment']
            rs.append('impact_review:'+str(validated['version']))
        if assessment=='withdrawn':assessment='pending';rs.append('evidence_withdrawn_not_false')
        pair=STATES[assessment]
        refs=list({w['id']:w for w in target_refs(records,target)+s['bindings'][req['id']]}.values());changed=source_changes(records,refs,at,mode)
        if changed:pair=STATES['pending'];rs+=changed
        # A review of an underlying original also affects a collective or
        # semantic record using it. Mere withdrawal is never a factual negation.
        for source_ref in refs:
            source_target=dict(kind='source',id=source_ref['id'],revision=source_ref['revision'])
            if source_target==target:continue
            underlying=exact(records,'impact',digest(source_target),known=known)
            if underlying:
                judgment=underlying['payload']['support']['detail']['judgment']
                if judgment!='supported':
                    pair=STATES['conflicting' if judgment=='conflicting' else 'pending'];rs.append('underlying_evidence_review:'+source_ref['id'])
        if target['kind']=='justification':
            target_record=exact(records,'justification',target['id'],target['version'],known=known)
            if target_record is None:pair=STATES['pending'];rs.append('dependency_not_known_at_cut')
            else:
                sub=evaluate_one(records,target_record,known,at,mode,stack+(key,),meter);sub_pair=STATES[sub['state']]
                pair=sub_pair if sub['state'] in ('pending','conflicting') else (pair[0] and sub_pair[0],pair[1] or sub_pair[1]);rs+=sub['reasons']
                rs += [reason for child in sub['requirements'] for reason in child['reasons'] if reason=='dependency_cycle_or_depth']
                if mode=='current' and exact(records,'justification',target['id'],known=known)['version']!=target['version']:
                    pair=STATES['pending'];rs.append('dependency_new_version')
        elif target['kind']=='collective':
            from .collectives import dispatch_collective
            group=external(records,'collectives',lambda store:dispatch_collective(store,dict(op='collective_get',id=target['id'],version=target['version'],knownAt=known,validAt=at)))
            gd=group['record']['payload']['collective']['detail']
            if gd['state']!='active' or gd['negated'] or group['validity']!='within_declared_interval':pair=STATES['pending'];rs.append('collective_requires_review')
            if mode=='current':
                latest=external(records,'collectives',lambda store:dispatch_collective(store,dict(op='collective_get',id=target['id'],knownAt=known,validAt=at)))
                if latest['reference']!=group['reference']:pair=STATES['pending'];rs.append('collective_new_version')
        elif target['kind']=='record' and mode=='current':
            def latest_record(store):
                row=store.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? AND record_id=? AND recorded_at<=? ORDER BY version DESC LIMIT 1',(records.memory.scope,target['id'],sql_cut(known))).fetchone()
                return store._envelope(row,verify_sources=False)['version'] if row else None
            if external(records,'',latest_record)!=target['version']:pair=STATES['pending'];rs.append('semantic_record_new_version')
        values[req['id']]=pair;items.append(dict(id=req['id'],text=req['text'],target=target,declaredJudgment=req['judgment'],state=state(pair),reasons=rs,impact=reference(impact) if impact else None))
    result=STATES['pending'] if reasons else logic(d['logic'],values)
    def unknown(n):return ('operator' in n and (n['operator'] not in ('all','any','not') or any(unknown(c) for c in n['operands'])))
    if unknown(d['logic']):reasons.append('unsupported_operator_preserved')
    return dict(reference=reference(r),title=d['title'],state=state(result),validity=v,reasons=reasons,requirements=items,logic=d['logic'],sourceRefs=r['payload']['source_refs'],meaning='Declared support under this exact cut, not verified truth or permission.')

def evaluate(records,request):
    binding=request.get('decision');known=request.get('knownAt') or now();at=request.get('validAt') or known;instant(known);instant(at)
    mode=request.get('mode','current');require(mode in ('current','historical'),'SUPPORT_QUERY_MODE');d=decision(records,binding,known)
    alt=request.get('alternativeId');require(alt in [a['id'] for a in d['payload']['decision_case']['case']['alternatives']],'ALTERNATIVE_NOT_FOUND')
    rows=records.db.execute("SELECT record_id FROM record_versions WHERE scope=? AND json_extract(payload,'$.support.kind')='justification' AND json_extract(payload,'$.support.detail.decision.caseId')=? AND json_extract(payload,'$.support.detail.alternativeId')=? AND recorded_at<=? GROUP BY record_id ORDER BY record_id LIMIT 101",(records.memory.scope,binding['caseId'],alt,sql_cut(known))).fetchall()
    require(len(rows)<=100,'SUPPORT_CASE_BUDGET');items=[];other_versions=0;meter=[0];all_refs={r['id']:r for r in d['payload']['source_refs']}
    for row in rows:
        raw=records.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE record_id=? AND recorded_at<=? ORDER BY version DESC LIMIT 1',(row['record_id'],sql_cut(known))).fetchone()
        record=records._envelope(raw);detail=record['payload']['support']['detail']
        if detail['decision']!=binding:other_versions+=1;continue
        verified=history(records,'justification',record['payload']['support']['id'],known)[-1]
        for r in verified['payload']['source_refs']:all_refs[r['id']]=r
        items.append(evaluate_one(records,verified,known,at,mode,meter=meter))
    pairs=[STATES[i['state']] for i in items];overall=state((any(x[0] for x in pairs),all(x[1] for x in pairs))) if pairs else 'pending'
    from .decisions import rid as drid
    def latest(store):
        row=store.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? AND record_id=? AND recorded_at<=? ORDER BY version DESC LIMIT 1',(records.memory.scope,drid(records.memory.scope,binding['caseId']),sql_cut(known))).fetchone()
        return store._envelope(row,verify_sources=False)['version'] if row else None
    decision_changed=mode=='current' and external(records,'decisions',latest)!=binding['version']
    occurrences={records.memory.sources[r['id']]['occurrence_id'] for r in all_refs.values()};uses={}
    for i in items:
        for r in i['sourceRefs']:uses[r['id']]=uses.get(r['id'],0)+1
    maximum=request.get('maxBytes',100000);require(type(maximum) is int and 4096<=maximum<=100000,'SUPPORT_PACKET_BUDGET')
    result=dict(schema='afh.support-evaluation.v1',decision=binding,alternativeId=alt,knownAt=known,validAt=at,mode=mode,state=overall,items=items,decisionChanged=decision_changed,
        requiresReview=decision_changed or overall!='supported',otherDecisionVersions=other_versions,sourceRefs=list(all_refs.values()),maxBytes=maximum,
        independence=dict(distinctOccurrences=len(occurrences),sharedSources=[k for k,v in uses.items() if v>1],meaning='Distinct justifications are not proof of independent evidence.'),
        coverage='All admitted justifications for this exact decision version and alternative within bounded selected sources; absence is not global absence.',**POLICY)
    require(packet_bytes(result)<=maximum,'SUPPORT_PACKET_BUDGET');return result

def dispatch_support(records,request):
    op=request['op'];scope=records.memory.scope
    records.db.execute("CREATE INDEX IF NOT EXISTS support_decision_lookup ON record_versions(scope,json_extract(payload,'$.support.kind'),json_extract(payload,'$.support.detail.decision.caseId'),json_extract(payload,'$.support.detail.alternativeId'),record_id,recorded_at)")
    if op in ('support_put','support_impact'):
        kind='justification' if op=='support_put' else 'impact';detail=request.get('detail');key=request.get('id') if kind=='justification' else digest(detail.get('target')) if isinstance(detail,dict) else None;_identifier(key)
        version=request.get('expectedVersion',0);require(type(version) is int and version>=0,'INVALID_VERSION');chain=history(records,kind,key)
        previous=next((r for r in chain if r['version']==version),None);require(version==0 or previous is not None,'VERSION_CONFLICT')
        if version:require(request.get('binding')==reference(previous),'SUPPORT_BINDING_STALE')
        require(len(chain)<100 or any(r['version']==version+1 for r in chain),'SUPPORT_HISTORY_BUDGET')
        payload=compile_payload(records,kind,key,detail,previous);record=records.put(payload,expected_version=version,request_id=request.get('requestId'))
        return dict(reference=reference(record),record=record)
    if op in ('support_evaluate','support_review'):
        if op=='support_review':
            request_id=_identifier(request.get('requestId'));key='review-'+request_id
            contract={k:request.get(k) for k in ('decision','alternativeId','knownAt','validAt','mode','maxBytes')};contract['selection']=digest(sorted((s['id'],s['revision']) for s in records.memory.sources.values()))
            existing=exact(records,'receipt',key)
            if existing:
                require(existing['payload']['support']['contract']==contract,'IDEMPOTENCY_CONFLICT');return dict(reference=reference(existing),record=existing,result=existing['payload']['support']['result'],replayed=True)
            records.db.execute('BEGIN')
            try:result=evaluate(records,request)
            finally:records.db.rollback()
            require(len(result['sourceRefs'])<=20,'SUPPORT_SOURCE_BUDGET')
            s=dict(schema='afh.support.v1',kind='receipt',id=key,contract=contract,result=result,**POLICY)
            p=dict(id=record_id(scope,'receipt',key),scope=scope,type='decision_support_receipt',text='Revisión de impacto '+result['state'],actor=dict(id='deterministic-support-evaluator',role='system'),modality='observed',status='proposed',source_refs=result['sourceRefs'],support=s)
            r=records.put(p,expected_version=0,request_id=request_id);return dict(reference=reference(r),record=r,result=result,replayed=False)
        records.db.execute('BEGIN');return evaluate(records,request)
    require(op in ('support_get','support_history'),'UNKNOWN_SUPPORT_OPERATION');records.db.execute('BEGIN')
    kind=request.get('kind','justification');require(kind in ('justification','impact','receipt'),'SUPPORT_KIND');key=_identifier(request.get('id'));known=request.get('knownAt')
    if known is not None:instant(known)
    if op=='support_history':
        require(kind!='receipt','RECEIPT_IMMUTABLE');h=history(records,kind,key,known);require(len(_json(h).encode())<=4_000_000,'SUPPORT_HISTORY_RESPONSE_BUDGET');return [dict(reference=reference(r),record=r) for r in h]
    r=exact(records,kind,key,request.get('version'),known);require(r is not None,'SUPPORT_NOT_FOUND')
    if kind!='receipt':r=history(records,kind,key,r['recorded_at'])[-1]
    return dict(reference=reference(r),record=r)
