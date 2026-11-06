"""Bounded content review of existing N04 clauses after explicit new evidence.

Interpretations remain proposals. The immutable target, issuer, modality, literal
arguments, conditions and temporal claims are preserved. This receiver can revise
predicates, argument interpretations and resolution; unsupported edits fail closed.
"""
import copy, json
from .host import digest, require, now, witness, manifest
from .knowledge_records import _json
from .review_contract import _clauses

def table(records):
    records.db.executescript('''CREATE TABLE IF NOT EXISTS afh_reevaluation_receipts(
      request_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, receipt TEXT NOT NULL, receipt_hash TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS reevaluation_no_update BEFORE UPDATE ON afh_reevaluation_receipts BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE TRIGGER IF NOT EXISTS reevaluation_no_delete BEFORE DELETE ON afh_reevaluation_receipts BEGIN SELECT RAISE(ABORT,'append only'); END;''')

def prepare(records, request):
    r=records.get(request['id'],request['scope']);ids=request['newSourceIds']
    require(isinstance(ids,list) and 1<=len(ids)<=64 and len(ids)==len(set(ids)),'REEVALUATION_SOURCE_BUDGET')
    require(bool(r['payload'].get('semantic_unit')),'REEVALUATION_SEMANTIC_TARGET')
    dependency_ids=request.get('dependencyIds',[])
    require(isinstance(dependency_ids,list) and len(dependency_ids)<=32 and len(set(dependency_ids))==len(dependency_ids),'REEVALUATION_DEPENDENCY_BUDGET')
    dependencies=[records.get(id,request['scope']) for id in dependency_ids if id!=r['id']]
    old_ids={s['id'] for s in r['payload']['source_refs']}
    require(any(s not in old_ids for s in ids),'REEVALUATION_NO_NEW_SOURCE')
    originals=[]
    for sid in sorted(old_ids|set(ids)|{s['id'] for d in dependencies for s in d['payload']['source_refs']}):
        s=records.memory.evidence(sid)
        originals.append({k:s[k] for k in ['id','revision','occurrence_id','source_conversation_id','role','text','text_sha256','record_sha256']})
    packet={'kind':'afh-reevaluation-input-1','target':r,'dependencies':dependencies,'newSourceIds':ids,'eventId':request['eventId'],'sourceCut':request['sourceCut'],'originals':originals}
    require(len(_json(packet).encode())<=100000,'REEVALUATION_CONTEXT_BUDGET')
    return {**packet,'sha256':digest(packet)}

def verify(records, packet, request_id):
    require(packet.get('sha256')==digest({k:v for k,v in packet.items() if k!='sha256'}),'REEVALUATION_PACKET_HASH')
    for s in packet['originals']:
        fresh=records.memory.evidence(s['id'])
        require(all(fresh[k]==v for k,v in s.items()),'REEVALUATION_SOURCE_CHANGED')
    r=records.get(packet['target']['id'],records.memory.scope,version=packet['target']['version'])
    require(r==packet['target'],'REEVALUATION_TARGET_HASH')
    prior=records.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE request_id=?',(request_id,)).fetchone()
    if prior:
        done=records._envelope(prior)
        require(done['payload'].get('afh_reevaluation',{}).get('packetSha256')==packet['sha256'],'REEVALUATION_IDEMPOTENCY_CONFLICT')
        return {'replay':True}
    table(records)
    row=records.db.execute('SELECT * FROM afh_reevaluation_receipts WHERE request_id=?',(request_id,)).fetchone()
    if row:
        require(digest(json.loads(row['receipt']))==row['receipt_hash'],'REEVALUATION_RECEIPT_CORRUPT')
        require(json.loads(row['receipt'])['receipt']['packetSha256']==packet['sha256'],'REEVALUATION_IDEMPOTENCY_CONFLICT')
        return {'replay':True}
    require(records.get(r['id'],records.memory.scope)['version']==r['version'],'STALE_REEVALUATION_TARGET')
    for dependency in packet['dependencies']:
        require(records.get(dependency['id'],records.memory.scope)==dependency,'STALE_REEVALUATION_DEPENDENCY')
    return {'replay':False}

def apply(records, request):
    packet=request['packet'];output=request['output'];rid=request['requestId'];producer=request['producer']
    require(isinstance(rid,str) and 1<=len(rid)<=160 and isinstance(producer,str) and 1<=len(producer)<=200,'REEVALUATION_ATTRIBUTION')
    verify(records,packet,rid)
    input_hash=digest([packet,output,producer]);table(records)
    row=records.db.execute('SELECT * FROM afh_reevaluation_receipts WHERE request_id=?',(rid,)).fetchone()
    if row:
        require(row['input_hash']==input_hash,'REEVALUATION_IDEMPOTENCY_CONFLICT')
        return json.loads(row['receipt'])
    require(isinstance(output,dict) and set(output)=={'disposition','reason','summary','clauses'},'REEVALUATION_OUTPUT_SCHEMA')
    require(output['disposition'] in ['changed','no_change','insufficient_context'],'REEVALUATION_DISPOSITION')
    require(isinstance(output['reason'],str) and 0<len(output['reason'])<=4000 and isinstance(output['summary'],str) and len(output['summary'])<=8000,'REEVALUATION_OUTPUT_TEXT')
    require(isinstance(output['clauses'],list) and len(output['clauses'])<=24,'REEVALUATION_CLAUSE_BUDGET')
    require(len(_json(output).encode())<=100000,'REEVALUATION_OUTPUT_BUDGET')
    prior=packet['target'];payload=copy.deepcopy(prior['payload']);unit=payload['semantic_unit'];changed=[]
    receipt={'requestId':rid,'inputSha256':input_hash,'packetSha256':packet['sha256'],'outputSha256':digest(output),'producer':producer,'eventId':packet['eventId'],'priorVersion':prior['version'],'disposition':output['disposition'],'reason':output['reason'],'sourceCut':packet['sourceCut']}
    if output['disposition']=='changed':
        require(bool(output['clauses']) and bool(output['summary']),'REEVALUATION_CHANGED_EMPTY')
        by_id={c['semantic_clause_id']:c for c in unit['clauses']};seen=set();allowed={s['id'] for s in packet['originals']}
        refs={r['id']:r['revision'] for r in payload['source_refs']}
        def witnesses(items):
            require(isinstance(items,list) and 1<=len(items)<=16,'REEVALUATION_EVIDENCE_REQUIRED')
            require(all(isinstance(e,dict) and e.get('sourceId') in allowed for e in items),'REEVALUATION_SOURCE_OUTSIDE_PACKET')
            ws=[witness(records.memory,e,unit['target_ref']['id']) for e in items]
            for w in ws:refs[w['source_id']]=w['revision']
            return ws
        for patch in output['clauses']:
            require(isinstance(patch,dict) and set(patch)=={'clauseId','predicate','resolution','arguments','evidence'},'REEVALUATION_PATCH_SCHEMA')
            cid=patch['clauseId'];require(cid in by_id and cid not in seen,'REEVALUATION_CLAUSE_MAPPING');seen.add(cid);c=by_id[cid];before=copy.deepcopy(c)
            require(isinstance(patch['predicate'],str) and 0<len(patch['predicate'])<=2000,'REEVALUATION_PREDICATE')
            require(patch['resolution'] in ['resolved','insufficient_context','ambiguous','conflicting_evidence','new_concept_candidate','not_applicable','not_stated','unrepresented'],'REEVALUATION_RESOLUTION')
            require(isinstance(patch['evidence'],list),'REEVALUATION_EVIDENCE_REQUIRED')
            # An unchanged predicate keeps its original literal witnesses. A
            # newly resolved argument need not duplicate its citation here.
            require(bool(patch['evidence']) or patch['predicate']==c['predicate']['value'],'REEVALUATION_PREDICATE_EVIDENCE_REQUIRED')
            ws=witnesses(patch['evidence']) if patch['evidence'] else []
            used=list(ws);dependency_witnesses=[('/predicate',w) for w in ws]
            c['predicate']['value']=patch['predicate'];c['resolution']=patch['resolution']
            require(isinstance(patch['arguments'],list) and len(patch['arguments'])<=len(c['arguments']),'REEVALUATION_ARGUMENT_MAPPING')
            indices=set()
            for arg in patch['arguments']:
                require(isinstance(arg,dict) and set(arg)=={'index','interpreted','evidence'},'REEVALUATION_ARGUMENT_SCHEMA')
                i=arg['index'];require(type(i) is int and 0<=i<len(c['arguments']) and i not in indices,'REEVALUATION_ARGUMENT_MAPPING');indices.add(i)
                require(isinstance(arg['interpreted'],str) and len(arg['interpreted'])<=4000,'REEVALUATION_ARGUMENT_TEXT')
                aws=witnesses(arg['evidence']);used+=aws;p=f'/arguments/{i}/interpreted';a=c['arguments'][i]
                if arg['interpreted']:
                    a['interpreted']=arg['interpreted'];a['evidence_keys']=sorted(set(a['evidence_keys']+[p]));c['evidence_by_field'][p]=aws
                    dependency_witnesses.extend((p,w) for w in aws)
                else:
                    a.pop('interpreted',None);a['evidence_keys']=[k for k in a['evidence_keys'] if k!=p];c['evidence_by_field'].pop(p,None)
            semantic=lambda x:[x['predicate'],x['resolution'],[{k:v for k,v in a.items() if k!='evidence_keys'} for a in x['arguments']]]
            require(semantic(c)!=semantic(before),'REEVALUATION_NO_SEMANTIC_CHANGE')
            require(any(w['source_id'] in packet['newSourceIds'] for w in used),'REEVALUATION_NEW_CONTEXT_REQUIRED')
            if ws:c['evidence_by_field']['/predicate']=ws
            c['evidence_by_field']['/resolution']=copy.deepcopy(ws or used)
            c['applicability']='inspectable_only'
            for witnesses_ in c['evidence_by_field'].values():
                for w in witnesses_:w['judgment']='pending';w.pop('judgment_receipt',None);w.pop('reason',None)
            revised={*[f'/arguments/{i}/interpreted' for i in indices]}
            if ws:revised.add('/predicate')
            c['dependencies']=[d for d in c['dependencies'] if d['field_pointer'] not in revised]
            for pointer,w in dependency_witnesses:
                if w['purpose']=='context':c['dependencies'].append({'slot':'reeval-'+digest([rid,pointer,w])[:32],'field_pointer':pointer,'source_ref':{'id':w['source_id'],'revision':w['revision'],'quote':w['quote'],'locator':w['locator']}})
            c['dependencies']=list({d['slot']:d for d in c['dependencies']}.values())
            c.pop('clause_version_id');c['clause_version_id']='cv-'+digest(c)[:48];changed.append(cid)
        unit['context_cut']['source_cut']=packet['sourceCut'];unit['completeness']='partial';unit['manifest']['pending_keys']=sorted(set(unit['manifest']['pending_keys']+['semantic_support']))
        manifest(unit);_clauses(prior['payload']['semantic_unit'],unit)
        payload['text']=output['summary'];payload['source_refs']=[{'id':k,'revision':v} for k,v in sorted(refs.items())]
        payload['status']='proposed';payload.pop('approval',None);payload['afh_reevaluation']={**receipt,'changedClauses':changed}
        previous_guard=getattr(records,'_afh_generation_guard',None)
        def guarded_write():
            if previous_guard:previous_guard()
            # The dependency cut is checked again under the same N04 write lock
            # as the successor CAS. Exact committed replays keep their old cut.
            if not records.db.execute('SELECT 1 FROM record_versions WHERE request_id=?',(rid,)).fetchone():
                for dependency in packet['dependencies']:
                    require(records.get(dependency['id'],records.memory.scope)==dependency,'STALE_REEVALUATION_DEPENDENCY')
        records._afh_generation_guard=guarded_write
        try:result_record=records.put(payload,expected_version=prior['version'],request_id=rid)
        finally:
            if previous_guard:records._afh_generation_guard=previous_guard
            else:del records._afh_generation_guard
    else:
        require(not output['clauses'] and not output['summary'],'REEVALUATION_UNCHANGED_HAS_PATCH')
        result_record=prior
    result={'record':result_record,'disposition':output['disposition'],'changedClauses':changed,'receipt':receipt,'approval':'none'}
    records.db.execute('BEGIN IMMEDIATE')
    try:
        if hasattr(records,'_afh_generation_guard'):records._afh_generation_guard()
        if output['disposition']!='changed':
            require(records.get(prior['id'],records.memory.scope)['version']==prior['version'],'STALE_REEVALUATION_TARGET')
            for dependency in packet['dependencies']:
                require(records.get(dependency['id'],records.memory.scope)==dependency,'STALE_REEVALUATION_DEPENDENCY')
        row=records.db.execute('SELECT * FROM afh_reevaluation_receipts WHERE request_id=?',(rid,)).fetchone()
        if row:require(row['input_hash']==input_hash,'REEVALUATION_IDEMPOTENCY_CONFLICT')
        else:records.db.execute('INSERT INTO afh_reevaluation_receipts VALUES(?,?,?,?)',(rid,input_hash,_json(result),digest(result)))
        records.db.commit()
    except Exception:records.db.rollback();raise
    return result

def dispatch_reevaluation(records,request):
    op=request['op']
    if op=='reevaluation_published':
        records.get(request['id'],records.memory.scope,version=request['version'])
        row=records.db.execute('SELECT j.state FROM afh_publication_jobs j JOIN g1_projection_outbox o USING(outbox_id) WHERE o.record_id=? AND o.record_version=?',(request['id'],request['version'])).fetchone()
        require(row is not None and row['state']=='published','REEVALUATION_PUBLICATION_PENDING')
        return {'published':True,'id':request['id'],'version':request['version']}
    if op=='reevaluation_prepare':return prepare(records,request)
    if op=='reevaluation_verify':return verify(records,request['packet'],request['requestId'])
    if op=='reevaluation_apply':return apply(records,request)
    raise ValueError('UNKNOWN_REEVALUATION_OPERATION')
