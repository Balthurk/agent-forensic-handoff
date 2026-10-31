"""AFH-owned adapter and semantic workflow. All sources come from verified AFH readers.

The source registry stores bindings, not another copy of the original corpus.
No live Noetis imports, default paths, authority or network services are used.
"""
import copy, hashlib, json, sqlite3, re
from pathlib import Path
from datetime import datetime, timezone
from .knowledge_records import KnowledgeRecords, RecordError, _json
from .semantic_support import validate_review_receipt, verified_clause_support, _pointer
from .review_contract import _clauses
from .relational_memory import instant
from .postgres_backend import connect as semantic_connect, restrict_sources

def digest(value): return hashlib.sha256(_json(value).encode('utf8')).hexdigest()
def now(): return datetime.now(timezone.utc).isoformat(timespec='microseconds')
def require(ok,code):
    if not ok: raise RecordError(code)

class AFHMemory:
    def __init__(self,root,sources,scope,*,register=False):
        self.scope=scope; self.sources={}; self.path=Path(root)/'corpus.sqlite3'; self._binding_cache={}
        for e in sources:
            require(isinstance(e,dict) and e.get('verified') is True,'AFH_UNVERIFIED_SOURCE')
            require(e.get('coordinate_space')=='AFH-representation-text-v1','AFH_COORDINATE_SPACE')
            require(hashlib.sha256(e['text'].encode('utf8')).hexdigest()==e['text_sha256'],'AFH_TEXT_HASH')
            require(e['id']==e['representation_id'] and e['revision']==e['payload_sha256'],'AFH_IDENTITY_BINDING')
            if e['id'] in self.sources: require(self.sources[e['id']]['revision']==e['revision'],'AFH_SOURCE_CONFLICT')
            self.sources[e['id']]=e
        self.db=semantic_connect(self.path)
        self.db.row_factory=sqlite3.Row
        self.db.executescript('''CREATE TABLE IF NOT EXISTS source_bindings (
            id TEXT PRIMARY KEY, revision TEXT NOT NULL, metadata TEXT NOT NULL, digest TEXT NOT NULL, registered_at TEXT NOT NULL);
            CREATE TRIGGER IF NOT EXISTS source_no_update BEFORE UPDATE ON source_bindings BEGIN SELECT RAISE(ABORT,'append only'); END;
            CREATE TRIGGER IF NOT EXISTS source_no_delete BEFORE DELETE ON source_bindings BEGIN SELECT RAISE(ABORT,'append only'); END;''')
        if register:
            with self.db:
                for e in sources:
                    metadata={k:e[k] for k in ['id','revision','occurrence_id','representation_id','payload_sha256','text_sha256','role','source_conversation_id','coordinate_space']}
                    prior=self.db.execute('SELECT * FROM source_bindings WHERE id=?',(e['id'],)).fetchone()
                    if prior: require(prior['digest']==digest(metadata) and digest(json.loads(prior['metadata']))==prior['digest'],'AFH_BINDING_CONFLICT')
                    else: self.db.execute('INSERT INTO source_bindings VALUES(?,?,?,?,?)',(e['id'],e['revision'],_json(metadata),digest(metadata),now()))
    def source_eligible(self,source_id,scope): return scope==self.scope and source_id in self.sources
    def evidence(self,source_id):
        require(source_id in self.sources,'AFH_SOURCE_NOT_SELECTED')
        e=self.sources[source_id]; row=self._binding_cache.get(source_id)
        if row is None:row=self.db.execute('SELECT * FROM source_bindings WHERE id=?',(source_id,)).fetchone()
        require(row is not None,'AFH_SOURCE_NOT_REGISTERED')
        meta=json.loads(row['metadata']);require(digest(meta)==row['digest'] and all(e[k]==v for k,v in meta.items()),'AFH_REGISTRY_CORRUPT')
        # The binding table is append-only. Reuse only within this request's
        # freshly verified source selection, and recheck that selection each
        # time. Permissions and original revisions are never cached across calls.
        if getattr(self.db,'postgres',False):self._binding_cache[source_id]=row
        return {**e,'project':self.scope,'occurrences':[{'project':self.scope,'id':e['occurrence_id']}],'lookup_status':'complete'}
    def close(self): self.db.close()

def ref(memory,source_id,quote,start=None):
    e=memory.evidence(source_id);text=e['text']
    require(isinstance(quote,str) and bool(quote),'QUOTE_REQUIRED')
    if start is None:
        # Search from the next codepoint so overlapping occurrences are ambiguous.
        first=text.find(quote)
        require(first>=0 and text.find(quote,first+1)<0,'QUOTE_AMBIGUOUS_OR_MISSING');start=first
    require(type(start) is int and 0<=start<len(text) and text[start:start+len(quote)]==quote,'QUOTE_MISMATCH')
    return {'id':e['id'],'revision':e['revision'],'quote':quote,'locator':{'coordinate_system':'unicode_codepoints','source_encoding':'AFH-representation-text-v1','decoder_version':'afh-evidence-text-v1','start':start,'end':start+len(quote)}}

def witness(memory,value,target_id):
    r=ref(memory,value['sourceId'],value['quote'],value.get('start'))
    return {'source_id':r['id'],'revision':r['revision'],'locator':r['locator'],'quote':r['quote'],'source_role':memory.evidence(r['id'])['role'],'purpose':'target' if r['id']==target_id else 'context','judgment':'pending'}

def manifest(unit):
    unit['manifest']={'entries':sorted([{'semantic_clause_id':c['semantic_clause_id'],'clause_version_id':c['clause_version_id'],'clause_sha256':digest(c),'dependency_slots':sorted(d['slot'] for d in c['dependencies'])} for c in unit['clauses']],key=lambda v:v['semantic_clause_id']),
        'completeness':unit['completeness'],'pending_keys':unit.get('manifest',{}).get('pending_keys',['semantic_support'])}

def compile_act(memory,act,producer,cut):
    target_id=act['targetSourceId'];target=memory.evidence(target_id)
    require(isinstance(act.get('clauses'),list) and 1<=len(act['clauses'])<=24,'CLAUSES_REQUIRED')
    act_id='act-'+digest([target['occurrence_id'],act['modality'],act['key']])[:48]
    clauses=[]; refs={target_id:target['revision']}; mentions=[]
    for i,draft in enumerate(act['clauses']):
        target_ref=ref(memory,target_id,draft['quote'],draft.get('start'))
        base=witness(memory,{'sourceId':target_id,'quote':draft['quote'],'start':target_ref['locator']['start']},target_id)
        evidence={k:[copy.deepcopy(base)] for k in ['/issuer/role','/predicate','/modality','/polarity']}
        cid='cl-'+digest([act_id,draft['key']])[:48]
        clause={'semantic_clause_id':cid,'target_ref':target_ref,'predicate':{'kind':'provisional_literal','value':draft['predicate'],'vocabulary_version':'afh-semantic-1'},'arguments':[],
            'polarity':draft['polarity'],'modality':act['modality'],'resolution':draft['resolution'],'applicability':'inspectable_only','conditions':[],'temporal':[],'alternatives':[],'relations':[],'dependencies':[],'evidence_by_field':evidence}
        arguments=draft['arguments'] or [{'role':'literal_content','literal':draft['quote'],'interpreted':'','evidence':[{'sourceId':target_id,'quote':draft['quote'],'start':target_ref['locator']['start']}]}]
        for j,arg in enumerate(arguments):
            pointer=f'/arguments/{j}'; keys=[pointer+'/role',pointer+'/literal']
            ws=[witness(memory,r,target_id) for r in arg['evidence']];require(bool(ws),'ARGUMENT_EVIDENCE_REQUIRED')
            value={'role':arg['role'],'literal':arg['literal'],'evidence_keys':keys.copy()}
            for k in keys: evidence[k]=copy.deepcopy(ws)
            if arg.get('interpreted'):
                value['interpreted']=arg['interpreted'];value['evidence_keys'].append(pointer+'/interpreted');evidence[pointer+'/interpreted']=copy.deepcopy(ws)
                if arg['literal'].casefold() in ['ella','él','el','eso','esa','ese','ellos','ellas','it','he','she','they','that'] and not any(w['purpose']=='context' for w in ws):
                    clause['resolution']='insufficient_context';value.pop('interpreted');value['evidence_keys'].remove(pointer+'/interpreted');evidence.pop(pointer+'/interpreted')
            clause['arguments'].append(value)
            for w in ws:
                refs[w['source_id']]=w['revision']
                if w['purpose']=='context':clause['dependencies'].append({'slot':f'arg{j}-'+str(len(clause['dependencies'])),'field_pointer':pointer+'/literal','source_ref':{'id':w['source_id'],'revision':w['revision'],'quote':w['quote'],'locator':w['locator']}})
            mention={'id':'mention-'+digest([cid,j,ws])[:48],'literal':arg['literal'],'role':arg['role'],'source_refs':copy.deepcopy(ws),'entity_candidate_id':'entity-'+digest([memory.scope,target['source_conversation_id'],arg['literal']])[:48],'equivalence':'candidate_only_no_merge'}
            mentions.append(mention)
        for j,c in enumerate(draft.get('conditions',[])):
            p=f'/conditions/{j}';ws=[witness(memory,r,target_id) for r in c['evidence']]
            value={'literal':c['literal'],'resolution':c['resolution'],'evidence_keys':[p+'/literal',p+'/ast'],'ast':{'kind':'literal_condition' if c['resolution']=='resolved' else 'unresolved','literal':c['literal'],'scope':c['scope'],'quantifier':'unknown','evidence_keys':[p+'/literal']}}
            clause['conditions'].append(value);evidence[p+'/literal']=copy.deepcopy(ws);evidence[p+'/ast']=copy.deepcopy(ws)
        for j,t in enumerate(draft.get('temporal',[])):
            p=f'/temporal/{j}';ws=[witness(memory,r,target_id) for r in t['evidence']]
            value={k:t[k] for k in ['dimension','status','literal']};value['evidence_keys']=[p+'/literal']
            if t.get('value'):
                require(t['status'] in ['exact','approximate'],'TEMPORAL_VALUE_STATUS')
                try:
                    instant(t['value']);offset=datetime.fromisoformat(t['value'].replace('Z','+00:00')).utcoffset()
                    value.update(value=t['value'],precision='instant',zone={'kind':'utc_offset','offset_minutes':int(offset.total_seconds()/60)})
                except RecordError:
                    # Keep the original model value as an explicitly unrepresented
                    # extension; never invent a timezone or turn a date into midnight.
                    value['status']='ambiguous';clause.setdefault('afh_temporal_unparsed',[]).append(copy.deepcopy(t));clause['unrepresented_fields']=['/afh_temporal_unparsed']
            clause['temporal'].append(value)
            for key in ['dimension','status','literal','value']:
                if key in value:evidence[p+'/'+key]=copy.deepcopy(ws)
        for j,r in enumerate(draft.get('relations',[])):
            p=f'/relations/{j}';ws=[witness(memory,v,target_id) for v in r['evidence']]
            clause['relations'].append({'kind':r['kind'],'direction':'outgoing','status':'candidate','target_clause_version_id':r['targetClauseVersionId'],'evidence_keys':[p]});evidence[p]=ws
        for ws in evidence.values():
            for w in ws: refs[w['source_id']]=w['revision']
        clause['clause_version_id']='cv-'+digest(clause)[:48];clauses.append(clause)
    start=min(c['target_ref']['locator']['start'] for c in clauses);end=max(c['target_ref']['locator']['end'] for c in clauses)
    unit={'schema_version':'noetis.semantic-act.v1','act_id':act_id,'local_act_key':act['key'],'scope':memory.scope,'target_ref':ref(memory,target_id,target['text'][start:end],start),'content_kind':act['type'],'issuer':{'role':target['role'],'evidence_keys':['/issuer/role']},'clauses':clauses,'interpretation_version':'afh-semantic-1','context_cut':{'scope':memory.scope,'source_cut':cut,'authorization_snapshot':'local-analysis-only-no-action-authority'},'completeness':'partial'}
    manifest(unit)
    return {'id':'rec-'+digest(act_id)[:48],'scope':memory.scope,'type':act['type'],'text':act['summary'],'actor':{'id':producer,'role':'agent'},'modality':act['modality'],'source_refs':[{'id':k,'revision':v} for k,v in sorted(refs.items())],'status':'proposed','semantic_unit':unit,'afh_mentions':mentions,'afh_extraction':{'source_role':target['role'],'coverage':'selected targets and supplied context only'}}

def clause_index(records,scope,known_at=None):
    if known_at is not None:instant(known_at)
    # Fix one SQLite read snapshot. New versions are selected by system time,
    # independently of semantic validity; old evidence is never backdated.
    rows=records.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? ORDER BY record_id,version LIMIT 5001',(scope,)).fetchall()
    require(len(rows)<=5000,'SEMANTIC_QUERY_ROW_BUDGET')
    if hasattr(records.db,'prefetch_integrity'):records.db.prefetch_integrity(rows)
    latest={}; versions={}; limitations=[];latest_rows={}
    if getattr(records,'selection_restricted',False):limitations.append({'reason':'unselected_semantic_lineages_not_scanned','scope':'Only records touching the selected verified sources, including all their versions; no global absence or completeness claim'})
    for row in rows:
        if not known_at or instant(row['recorded_at'])<=instant(known_at):latest_rows[row['record_id']]=row['version']
    for row in rows:
        if known_at and instant(row['recorded_at'])>instant(known_at):continue
        payload=json.loads(row['payload'])
        if any(not records.memory.source_eligible(r['id'],scope) for r in payload['source_refs']):
            limitations.append({'record':row['record_id'],'reason':'source_outside_selection'});continue
        record=records._envelope(row)
        if latest_rows[record['id']]==record['version']:latest[record['id']]=record
        for c in record['payload'].get('semantic_unit',{}).get('clauses',[]):versions[c['clause_version_id']]={'record':record,'clause':c}
    active={c['clause_version_id']:{'record':r,'clause':c} for r in latest.values() for c in r['payload'].get('semantic_unit',{}).get('clauses',[])}
    return latest,active,versions,limitations

def temporal_state(clause,valid_at):
    if valid_at is None:return 'not_filtered'
    at=instant(valid_at);ts=[v for v in clause.get('temporal',[]) if v['dimension']=='validity']
    if not ts:return 'unknown'
    for t in ts:
        if t['status'] not in ['exact','open_bound'] or 'bounds' not in t:return 'unknown'
        bounds=t['bounds'];lo=bounds.get('lower');hi=bounds.get('upper')
        if any(b and (b.get('precision')!='instant' or b.get('zone',{}).get('kind')!='utc_offset') for b in [lo,hi]):return 'unknown'
        if lo and (at<instant(lo['value']) or at==instant(lo['value']) and not lo['inclusive']):return 'outside'
        if hi and (at>instant(hi['value']) or at==instant(hi['value']) and not hi['inclusive']):return 'outside'
    return 'inside'

def query_records(records,request,*,snapshot_index=None):
    roots=request.get('roots',[]);limit=request.get('limit',20)
    require(isinstance(roots,list) and len(roots)<=100 and all(isinstance(v,str) for v in roots),'ROOT_BUDGET')
    require(type(limit) is int and 1<=limit<=100,'ROOT_BUDGET')
    scope=request['scope'];latest,active,versions,limits=snapshot_index if snapshot_index is not None else clause_index(records,scope,request.get('knownAt'))
    require(len(versions)<=5000,'SEMANTIC_QUERY_ROW_BUDGET')
    q=request.get('question','');tokens=set(re.findall(r'\w{3,}',q.casefold())); roots=request.get('roots',[])
    require(type(request.get('hops',2)) is int and 0<=request.get('hops',2)<=3,'HOP_LIMIT')
    if roots:require(all(v in versions for v in roots),'ROOT_NOT_AVAILABLE')
    scored=[]
    for vid,item in active.items():
        c=item['clause'];text=_json([item['record']['payload']['text'],c['predicate'],c['arguments'],c.get('conditions',[])]).casefold()
        score=sum(t in text for t in tokens)
        if (vid in roots if roots else score>0):scored.append((score,vid))
    scored.sort(key=lambda x:(-x[0],x[1])); selected=set(roots) if roots else set(v for _,v in scored[:request.get('limit',20)]); frontier=set(selected);edges=[];missing=[]
    # Traverse both directions so a rule retrieves its exception/revocation.
    # Exact version targets stay exact; selecting a newer record never rewrites edges.
    all_edges=[]
    for vid,item in versions.items():
        for r in item['clause'].get('relations',[]):all_edges.append({'from':vid,'to':r['target_clause_version_id'],**r})
    for _ in range(request.get('hops',2)):
        next_frontier=set()
        for e in all_edges:
            if e['from'] not in active and e['from'] not in frontier:continue
            if e['from'] not in frontier and e['to'] not in frontier:continue
            if e not in edges:edges.append(e)
            for v in [e['from'],e['to']]:
                if v not in versions:missing.append({'version':v,'reason':'target_unavailable_at_cut_or_selection'})
                elif v not in selected:next_frontier.add(v)
        selected.update(next_frontier);frontier=next_frontier
        require(len(selected)<=100 and len(edges)<=300,'SEMANTIC_GRAPH_BUDGET')
    for e in all_edges:
        if (e['from'] in selected or e['from'] in active and e['to'] in selected) and e not in edges:
            missing.append({'version':e['to'] if e['from'] in selected else e['from'],'reason':'relation_not_traversed_within_hop_budget'})
    items=[]
    for vid in sorted(selected):
        item=versions[vid];c=item['clause'];r=item['record'];unit=r['payload']['semantic_unit'];state=temporal_state(c,request.get('validAt'))
        # Unknown validity remains visible, explicitly provisional. Outside nodes
        # remain as context when connected, never silently treated as applicable.
        supports=verified_clause_support(records,r['payload'],c)
        refs={};
        for ws in c['evidence_by_field'].values():
            for w in ws:refs[(w['source_id'],w['revision'])]={'id':w['source_id'],'revision':w['revision']}
        items.append({'recordId':r['id'],'recordVersion':r['version'],'knownAt':r['recorded_at'],'clauseVersionId':vid,'clauseId':c['semantic_clause_id'],'currentAtCut':vid in active,'issuer':unit['issuer']['role'],'text':c['target_ref']['quote'],'predicate':c['predicate']['value'],'arguments':c['arguments'],'conditions':c.get('conditions',[]),'temporal':c.get('temporal',[]),'polarity':c['polarity'],'modality':c['modality'],'resolution':c['resolution'],'support':'supported' if supports else 'pending_or_rejected','validity':state,'status':r['payload']['status'],'sourceRefs':list(refs.values()),'occurrences':sorted({records.memory.evidence(x['id'])['occurrence_id'] for x in refs.values()})})
    return {'schema':'afh-semantic-context-1','knownAt':request.get('knownAt'),'validAt':request.get('validAt'),'items':items,'edges':edges,'missing':missing,'limitations':limits,'requiresAbstention':bool(missing) or any(x['support']!='supported' or x['resolution']!='resolved' or x['validity'] in ['unknown','outside'] for x in items),'authority':'Historical source interpretations only; no execution authority','coverage':'Only explicitly extracted targets; absent relation is not global absence','independentOccurrences':len({o for x in items for o in x['occurrences']})}

def prepare_review(records,record_id,scope,clause_id):
    r=records.get(record_id,scope);p=r['payload'];u=p['semantic_unit'];c=next((v for v in u['clauses'] if v['semantic_clause_id']==clause_id),None);require(c is not None,'CLAUSE_NOT_FOUND')
    originals={};fields=[]
    for ptr,ws in sorted(c['evidence_by_field'].items()):
        for w in ws:
            e=records._source({'id':w['source_id'],'revision':w['revision']},scope)
            originals[e['id']]={'source_id':e['id'],'revision':e['revision'],'source_role':e['role'],'record_sha256':e['record_sha256'],'text':e['text'],'text_sha256':e['text_sha256'],'text_coordinate_system':e['coordinate_space'],'scope':scope}
        fields.append({'field_pointer':ptr,'typed_claim':_pointer(u if ptr.startswith('/issuer/') else c,ptr),'evidence':copy.deepcopy(ws),'policy_error':None})
    content={'binding':{'query':{'project':scope},'record_id':record_id,'act_id':u['act_id'],'act_version':r['version'],'clause_version_id':c['clause_version_id'],'payload_sha256':digest(p),'manifest_sha256':digest(u['manifest']),'clause_sha256':digest(c),'interpretation_version':u['interpretation_version'],'policy_version':'afh-field-support-1'},'fields':fields,'originals':list(originals.values()),'issuer':u['issuer'],'administrative_actor':p['actor'],'clause':c,'dependencies':c['dependencies'],'pending_keys':u['manifest']['pending_keys']}
    packet={'kind':'n04.private-field-review-input.v1','content':content,'request_sha256':digest(content)}
    require(len(_json(packet).encode('utf8'))<=200000,'REVIEW_INPUT_BUDGET');return packet

def admit_review(records,packet,raw,reviewer,producer,request_id):
    previous=records.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE request_id=?',(request_id,)).fetchone()
    if previous:
        admissions=records.db.execute('SELECT review_request_sha256,reviewer_task_id,producer_task_id FROM semantic_support_admissions WHERE record_id=? AND version=?',(previous['record_id'],previous['version'])).fetchall()
        require(bool(admissions) and all(r['review_request_sha256']==digest([packet,raw]) and r['reviewer_task_id']==reviewer and r['producer_task_id']==producer for r in admissions),'IDEMPOTENCY_CONFLICT')
        return records._envelope(previous)
    binding=packet['content']['binding'];fresh=prepare_review(records,binding['record_id'],binding['query']['project'],packet['content']['clause']['semantic_clause_id'])
    require(digest(fresh)==digest(packet),'STALE_REVIEW_PACKET')
    sha=hashlib.sha256(raw.encode('utf8')).hexdigest();receipt,decisions=validate_review_receipt(packet,raw,receipt_sha256=sha,reviewer_task_id=reviewer,producer_task_id=producer)
    prior=records.get(binding['record_id'],binding['query']['project']);payload=copy.deepcopy(prior['payload']);u=payload['semantic_unit'];c=next(x for x in u['clauses'] if x['semantic_clause_id']==packet['content']['clause']['semantic_clause_id'])
    for ptr,d in decisions.items():
        for w in c['evidence_by_field'][ptr]:w.update(judgment=d['judgment'],reason=d['reason'],judgment_receipt=sha)
    c['clause_version_id']='cv-'+digest(c)[:48];c['applicability']='eligible_for_publication' if all(d['judgment']=='supported' for d in decisions.values()) else 'pending_support'
    # Deliberately preserve partial coverage: independent field review does not
    # establish that the model extracted every relevant clause in the source.
    manifest(u)
    admission={'record_id':payload['id'],'version':prior['version']+1,'payload_sha256':digest(payload),'packet_json':_json(packet),'receipt_raw':raw,'receipt_sha256':sha,'reviewer_task_id':reviewer,'producer_task_id':producer,'context_cut_json':_json(u['context_cut']),'review_request_sha256':digest([packet,raw])}
    records._pending_support_admission=[admission]
    try:return records.put(payload,expected_version=prior['version'],request_id=request_id)
    finally:records._pending_support_admission=[]

def correct(records,request):
    # Compare against the exact edited version. put() owns the current CAS check
    # and exact request replay, including a retry after a successful response loss.
    require(all(isinstance(request.get(k,d),str) and 0<len(request.get(k,d))<=2000 for k,d in [('editor','local-editor'),('reason','explicit full-payload correction')]),'CORRECTION_ATTRIBUTION')
    prior=records.get(request['id'],request['scope'],version=request['expectedVersion'])
    payload=copy.deepcopy(request['payload']);require(payload['id']==prior['id'] and payload['scope']==prior['payload']['scope'],'CORRECTION_TARGET')
    require(not(set(prior['payload'])-set(payload)),'CORRECTION_FIELDS_REMOVED')
    _clauses(prior['payload'].get('semantic_unit'),payload.get('semantic_unit'))
    old={c['semantic_clause_id']:c for c in prior['payload']['semantic_unit']['clauses']}
    changed=[]
    for c in payload['semantic_unit']['clauses']:
        if c!=old[c['semantic_clause_id']]:
            changed.append(c['semantic_clause_id'])
            c['applicability']='inspectable_only'
            for ws in c['evidence_by_field'].values():
                for w in ws:w['judgment']='pending';w.pop('judgment_receipt',None);w.pop('reason',None)
    payload['semantic_unit']['completeness']='partial';payload['semantic_unit']['manifest']['pending_keys']=sorted(set(payload['semantic_unit']['manifest']['pending_keys']+['semantic_support']))
    manifest(payload['semantic_unit'])
    payload['afh_corrections']=copy.deepcopy(prior['payload'].get('afh_corrections',[]))+[{'request_id':request['requestId'],'editor':request.get('editor','local-editor'),'identity_basis':'local declaration, not authenticated human identity','reason':request.get('reason','explicit full-payload correction'),'changed_clauses':changed}]
    return records.put(payload,expected_version=request['expectedVersion'],request_id=request['requestId'])

def dispatch(request):
    if request['op'].startswith('causal_'):
        from .causal import dispatch_causal
        request['scope']=request.get('scope','afh-corpus')
        root=Path(request['root']).resolve()/'causal';writing=request['op']=='causal_put'
        if not writing and not (root/'records.sqlite3').exists():return dispatch_causal(None,request)
        if writing:root.mkdir(parents=True,exist_ok=True)
        memory=AFHMemory(root,request.get('sources',[]),request['scope'],register=writing)
        try:
            records=KnowledgeRecords(memory,root/'records.sqlite3',read_only=not writing)
            try:return dispatch_causal(records,request)
            finally:records.close()
        finally:memory.close()
    if request['op'].startswith('intelligence_'):
        from .decision_intelligence import dispatch_intelligence
        request['scope']=request.get('scope','afh-corpus')
        root=Path(request['root']).resolve()/'intelligence';writing=request['op']=='intelligence_put'
        if not writing and not (root/'records.sqlite3').exists():return dispatch_intelligence(None,request)
        if writing:root.mkdir(parents=True,exist_ok=True)
        memory=AFHMemory(root,request.get('sources',[]),request['scope'],register=writing)
        try:
            records=KnowledgeRecords(memory,root/'records.sqlite3',read_only=not writing)
            try:return dispatch_intelligence(records,request)
            finally:records.close()
        finally:memory.close()
    if request['op'].startswith('retrospective_'):
        from .retrospectives import dispatch_retrospective
        request['scope']=request.get('scope','afh-corpus')
        root=Path(request['root']).resolve()/'retrospectives';writing=request['op']=='retrospective_put'
        if not writing and not (root/'records.sqlite3').exists():return dispatch_retrospective(None,request)
        if writing:root.mkdir(parents=True,exist_ok=True)
        memory=AFHMemory(root,request.get('sources',[]),request['scope'],register=writing)
        try:
            records=KnowledgeRecords(memory,root/'records.sqlite3',read_only=not writing)
            try:return dispatch_retrospective(records,request)
            finally:records.close()
        finally:memory.close()
    if request['op'].startswith('identity_'):
        from .identities import dispatch_identity, semantic_mentions
        request['scope']=request.get('scope','afh-corpus')
        if request['op']=='identity_mentions':return semantic_mentions(request)
        root=Path(request['root']).resolve()/'identities'
        writing=request['op']=='identity_put'
        if not writing and not (root/'records.sqlite3').exists():return dispatch_identity(None,request)
        if writing:root.mkdir(parents=True,exist_ok=True)
        memory=AFHMemory(root,request.get('sources',[]),request['scope'],register=writing)
        try:
            records=KnowledgeRecords(memory,root/'records.sqlite3',read_only=not writing)
            try:return dispatch_identity(records,request)
            finally:records.close()
        finally:memory.close()
    if request['op']=='context_history':
        from .context_history import dispatch_history
        return dispatch_history(request)
    if request['op']=='context_query':
        from .context_retrieval import dispatch_context
        return dispatch_context(request)
    if request['op'].startswith('support_'):
        from .justifications import dispatch_support
        root=Path(request['root']).resolve()/'supports';root.mkdir(parents=True,exist_ok=True)
        memory=AFHMemory(root,request.get('sources',[]),request.get('scope','afh-corpus'),register=request['op'] in ('support_put','support_impact','support_review'))
        try:
            records=KnowledgeRecords(memory,root/'records.sqlite3')
            try:return dispatch_support(records,request)
            finally:records.close()
        finally:memory.close()
    if request['op'].startswith('collective_'):
        from .collectives import dispatch_collective
        root=Path(request['root']).resolve()/'collectives';root.mkdir(parents=True,exist_ok=True)
        memory=AFHMemory(root,request.get('sources',[]),request.get('scope','afh-corpus'),register=request['op']=='collective_put')
        try:
            records=KnowledgeRecords(memory,root/'records.sqlite3')
            try:return dispatch_collective(records,request)
            finally:records.close()
        finally:memory.close()
    if request['op'].startswith('decision_'):
        from .decisions import dispatch_decision
        root=Path(request['root']).resolve()/'decisions';root.mkdir(parents=True,exist_ok=True)
        scope=request.get('scope','afh-corpus')
        memory=AFHMemory(root,request.get('sources',[]),scope,register=request['op'] in ('decision_frame','decision_act'))
        try:
            records=KnowledgeRecords(memory,root/'records.sqlite3')
            try:return dispatch_decision(records,request)
            finally:records.close()
        finally:memory.close()
    # Reuse N04 durability and source identity without mixing episode records
    # into the existing semantic-act list, coverage, graph or outbox channels.
    if request['op'].startswith('learning_'):
        from .learning import dispatch_learning
        root=Path(request['root']).resolve()/'learning';root.mkdir(parents=True,exist_ok=True)
        scope=request.get('scope','afh-corpus');request['scope']=scope
        memory=AFHMemory(root,request.get('sources',[]),scope,register=request['op']=='learning_record')
        records=KnowledgeRecords(memory,root/'records.sqlite3')
        try:return dispatch_learning(records,request)
        finally:records.close();memory.close()
    root=Path(request['root']).resolve();root.mkdir(parents=True,exist_ok=True);scope=request.get('scope','afh-corpus');request['scope']=scope
    memory=AFHMemory(root,request.get('sources',[]),scope,register=request['op'] in ['sync','put','extract','reevaluation_prepare'])
    records=KnowledgeRecords(memory,root/'records.sqlite3')
    try:
        op=request['op']
        records.db.execute('CREATE TABLE IF NOT EXISTS afh_generation_fences(id TEXT PRIMARY KEY,fence INTEGER NOT NULL)')
        if op=='generation_claim':
            require(type(request['fence']) is int and request['fence']>0,'GENERATION_FENCE_INVALID')
            with records.db:
                prior=records.db.execute('SELECT fence FROM afh_generation_fences WHERE id=?',(request['generationId'],)).fetchone()
                require(prior is None or prior[0]<=request['fence'],'GENERATION_STALE_FENCE')
                records.db.execute('INSERT INTO afh_generation_fences VALUES(?,?) ON CONFLICT(id) DO UPDATE SET fence=excluded.fence',(request['generationId'],request['fence']))
            return {'claimed':True,'fence':request['fence']}
        if op in ['extract','reevaluation_apply'] and request.get('generationId'):
            def guard():
                row=records.db.execute('SELECT fence FROM afh_generation_fences WHERE id=?',(request['generationId'],)).fetchone()
                require(row is not None and row[0]==request['fence'],'GENERATION_STALE_FENCE')
            records._afh_generation_guard=guard
        if op.startswith('reevaluation_'):
            from .reevaluation import dispatch_reevaluation
            return dispatch_reevaluation(records,request)
        if op.startswith('publication_'):
            from .publication import dispatch_publication
            return dispatch_publication(records,request)
        if op.startswith('graph_'):
            from .graph_publication import dispatch_graph
            return dispatch_graph(records,request)

        if op=='sync':return {'sources':len(memory.sources),'occurrences':len({e['occurrence_id'] for e in memory.sources.values()}),'coordinateSpace':'AFH-representation-text-v1'}
        if op=='put':return records.put(request['payload'],expected_version=request['expectedVersion'],request_id=request['requestId'])
        if op=='extract':
            results=[];errors=[]
            for i,act in enumerate(request['draft']['acts']):
                try:
                    payload=compile_act(memory,act,request['producer'],request['sourceCut'])
                    results.append(records.put(payload,expected_version=0,request_id=request['requestId']+'-'+str(i)))
                except (RecordError,ValueError,KeyError,TypeError) as error:errors.append({'act':i,'error':str(error)})
            return {'records':results,'errors':errors,'state':'partial' if errors else 'proposed','coverage':'selected targets only; no semantic completeness claim'}
        if op in ('query','list'):restrict_sources(records)
        if op=='query':return query_records(records,request)
        if op=='list':return list(clause_index(records,scope,request.get('knownAt'))[0].values())
        if op=='get':return records.get(request['id'],scope,version=request.get('version'))
        if op=='history':return records.history(request['id'],scope)
        if op=='correct':return correct(records,request)
        if op=='review_prepare':return prepare_review(records,request['id'],scope,request['clauseId'])
        if op=='review_admit':return admit_review(records,request['packet'],request['raw'],request['reviewer'],request['producer'],request['requestId'])
        raise RecordError('UNKNOWN_OPERATION')
    finally:records.close();memory.close()
