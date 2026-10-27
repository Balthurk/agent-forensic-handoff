"""F33: attributed reconstructions, never an inference of someone's mental state."""
import copy
from .knowledge_records import _identifier, _text, _json
from .collectives import require, digest, now, sql_cut
from .relational_memory import instant

SCHEMA = 'afh.retrospective.v1'
METHOD = 'explicit-source-composition-v1'
POLICY = dict(personalKnowledge='not_established', truth='not_established',
              completeness='not_certified', executionAuthority=False, humanAcceptance=False,
              attribution='local_declaration_not_authenticated')

def rid(scope, key): return 'retrospective-'+digest([scope, _identifier(key)])[:48]
def reference(record): return dict(id=record['payload']['retrospective']['id'], version=record['version'], digest=digest(record))

def evidence(records, items):
    from .host import ref
    require(isinstance(items, list) and 1 <= len(items) <= 8, 'RETRO_EVIDENCE_REQUIRED')
    bound = []
    for item in items:
        require(isinstance(item, dict) and set(item) <= {'sourceId','quote','start'}, 'RETRO_EVIDENCE_FIELDS')
        r = ref(records.memory, item.get('sourceId'), item.get('quote'), item.get('start'))
        bound.append(r)
    return bound

def compile_record(records, key, detail, previous, frozen=None):
    require(isinstance(detail, dict) and len(_json(detail).encode()) <= 160000, 'RETRO_INPUT_BUDGET')
    d = copy.deepcopy(detail)
    require(set(d) == {'title','subjectAt','sourceCut','actor','reason','state','claims','gaps','personalReports'}, 'RETRO_FIELDS')
    for k, n in [('title',400),('actor',128),('reason',2000)]: _text(d[k],k,n)
    instant(d['subjectAt']); instant(d['sourceCut'])
    require(d['state'] in ('active','withdrawn'), 'RETRO_STATE')
    require(isinstance(d['gaps'],list) and len(d['gaps']) <= 20, 'RETRO_GAPS')
    for gap in d['gaps']: _text(gap,'gap',2000)
    require(isinstance(d['claims'],list) and 1 <= len(d['claims']) <= 20, 'RETRO_CLAIMS')
    require(isinstance(d['personalReports'],list) and len(d['personalReports']) <= 20, 'RETRO_PERSONAL_BUDGET')
    bindings = {}; keys = set()
    for i, claim in enumerate(d['claims']):
        require(isinstance(claim,dict) and set(claim)=={'key','text','position','evidence'}, 'RETRO_CLAIM_FIELDS')
        key_ = _identifier(claim['key']); require(key_ not in keys,'RETRO_DUPLICATE_CLAIM'); keys.add(key_)
        _text(claim['text'],'claim',4000); require(claim['position'] in ('supports','contradicts','uncertain'),'RETRO_POSITION')
        bindings['claim/'+str(i)] = evidence(records,claim['evidence'])
    for i, report in enumerate(d['personalReports']):
        require(isinstance(report,dict) and set(report)=={'person','at','dateLiteral','report','evidence'}, 'RETRO_PERSONAL_FIELDS')
        _text(report['person'],'person',300); instant(report['at']); _text(report['dateLiteral'],'dateLiteral',64)
        require(report['report'] in ('received','acknowledged','denied','uncertain'), 'RETRO_PERSONAL_REPORT')
        bound = evidence(records,report['evidence'])
        # The explicit ISO date must occur with the person's name in one witness.
        literal = report['dateLiteral']
        require(len(literal)>=10 and report['at'].startswith(literal) and any(report['person'] in r['quote'] and literal in r['quote'] for r in bound),'RETRO_PERSON_DATE_NOT_LITERAL')
        bindings['personal/'+str(i)] = bound
    refs = {r['id']:dict(id=r['id'],revision=r['revision']) for bs in bindings.values() for r in bs}
    require(len(refs)<=40,'RETRO_SOURCE_BUDGET')
    if frozen is None:
        times=[]
        for source_id in sorted(refs):
            s=records.memory.evidence(source_id); known=s.get('known_at')
            if known is not None:
                instant(known); require(instant(known)<=instant(d['sourceCut']),'RETRO_SOURCE_AFTER_CUT')
            times.append(dict(id=source_id,revision=s['revision'],knownAt=known,emittedAt=s.get('emitted_at'),caseHash=s.get('caseHash')))
        selection=[list(pair) for pair in sorted({(s.get('conversationId',s.get('source_conversation_id')),s.get('caseHash')) for s in records.memory.sources.values()}, key=str)]
        frozen=dict(sources=times,selection=selection,selectedRepresentations=len(records.memory.sources))
    require(isinstance(frozen,dict) and set(frozen)=={'sources','selection','selectedRepresentations'},'RETRO_CAPTURE')
    require({(r['id'],r['revision']) for r in frozen['sources']}=={(r['id'],r['revision']) for r in refs.values()},'RETRO_CAPTURE_REFS')
    for s in frozen['sources']:
        if s['knownAt'] is not None: require(instant(s['knownAt'])<=instant(d['sourceCut']),'RETRO_SOURCE_AFTER_CUT')
    value=dict(schema=SCHEMA,id=key,method=METHOD,detail=d,bindings=bindings,capture=frozen,
               previous=reference(previous) if previous else None,**POLICY)
    return dict(id=rid(records.memory.scope,key),scope=records.memory.scope,type='retrospective_composition',text=d['title'],actor=dict(id=d['actor'],role='user'),modality='stated',status='proposed',source_refs=[refs[k] for k in sorted(refs)],retrospective=value)

def history(records, key, known=None, version=None):
    _identifier(key)
    if known is not None: instant(known)
    if version is not None: require(type(version) is int and 1<=version<=100,'RETRO_VERSION')
    rows=records.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? AND record_id=? AND recorded_at<=? AND version<=? ORDER BY version LIMIT 101', (records.memory.scope,rid(records.memory.scope,key),sql_cut(known or '9999-01-01T00:00:00Z'),version or 100)).fetchall()
    require(len(rows)<=100,'RETRO_HISTORY_BUDGET'); chain=[]
    for row in rows:
        record=records._envelope(row); value=record['payload'].get('retrospective',{})
        require(record['integrity']=='envelope_v1' and value.get('schema')==SCHEMA and value.get('id')==key,'RETRO_SCHEMA')
        require(record['version']==len(chain)+1,'RETRO_CHAIN_GAP')
        expected=compile_record(records,key,value['detail'],chain[-1] if chain else None,value['capture'])
        require(expected==record['payload'],'RETRO_BINDING'); chain.append(record)
    return chain

def exact(records, binding):
    require(isinstance(binding,dict) and set(binding)=={'id','version','digest'},'RETRO_REFERENCE')
    chain=history(records,binding['id'],version=binding['version']); require(chain and reference(chain[-1])==binding,'RETRO_REFERENCE_CHANGED')
    return chain[-1]

def public(records, record):
    v=record['payload']['retrospective']; d=v['detail']; reasons=[]
    late=[s['id'] for s in v['capture']['sources'] if s['knownAt'] and instant(s['knownAt'])>instant(d['subjectAt'])]
    unknown=[s['id'] for s in v['capture']['sources'] if s['knownAt'] is None]
    obsolete=[r['id'] for r in record['payload']['source_refs'] if records.memory.sources[r['id']].get('document',{}).get('currentRevision') is False]
    if late: reasons.append('sources_acquired_after_subject_date')
    if unknown: reasons.append('source_acquisition_time_unknown')
    if obsolete: reasons.append('historical_source_revision')
    if d['gaps']: reasons.append('declared_gaps')
    if any(c['position']!='supports' for c in d['claims']): reasons.append('adverse_or_uncertain_claims')
    if d['state']=='withdrawn': reasons.append('composition_withdrawn')
    groups={}
    for p in d['personalReports']: groups.setdefault((p['person'],p['at']),set()).add(p['report'])
    conflicts=[dict(person=k[0],at=k[1]) for k,values in groups.items() if 'denied' in values and values & {'received','acknowledged'}]
    if conflicts: reasons.append('conflicting_personal_reports')
    return dict(reference=reference(record),record=record,title=d['title'],state=d['state'],sourceRefs=record['payload']['source_refs'],recordedAt=record['recorded_at'],subjectAt=d['subjectAt'],sourceCut=d['sourceCut'],method=v['method'],lateSources=late,unknownAcquisition=unknown,historicalSources=obsolete,personalReportConflicts=conflicts,reasons=reasons,requiresReview=True,**POLICY)

def query(records, request):
    from .context_retrieval import heads, words
    view=request.get('view','corpus_reconstruction'); require(view in ('system_history','corpus_reconstruction','personal_evidence'),'RETRO_VIEW')
    known=request.get('knownAt') or now(); instant(known)
    if view=='system_history': require(request.get('knownAt'),'RETRO_HISTORY_CUT_REQUIRED')
    question=request.get('question',''); require(isinstance(question,str) and len(question)<=2000,'RETRO_QUESTION')
    result=dict(schema='afh.retrospective-query.v1',view=view,knownAt=known,items=[],outsideSelection=0,scanned=0,coverage='explicit_compositions_only_not_all_corpus',**POLICY)
    if records is None:return result
    for row in heads(records,known,500):
        result['scanned']+=1; raw=records._envelope(row,verify_sources=False);v=raw['payload'].get('retrospective',{})
        require(v.get('schema')==SCHEMA,'RETRO_SCHEMA')
        if any(not records.memory.source_eligible(r['id'],records.memory.scope) for r in raw['payload']['source_refs']): result['outsideSelection']+=1;continue
        chain=history(records,v['id'],known);record=chain[-1];item=public(records,record);d=record['payload']['retrospective']['detail']
        if question.strip() and not (words(question)&words(_json(d))):continue
        if view=='personal_evidence' and not d['personalReports']:continue
        # History means the interpretation existed then; it is not a reconstruction backdated to subjectAt.
        item['view']=view;result['items'].append(item)
    result['requiresAbstention']=bool(result['outsideSelection']) or view=='personal_evidence'
    return result

def context_units(records, request):
    result=query(records,dict(request,view='corpus_reconstruction')); units=[]
    for item in result['items']:
        units.append(dict(id='retrospective-'+item['reference']['digest'][:24],kind='retrospective',title=item['title'],sourceRefs=item['sourceRefs'],needs=['source','antecedent','scope','validity','contradiction'],requiresReview=True,blocked=bool(result['outsideSelection']),data=item))
    return result,units

def dispatch_retrospective(records, request):
    op=request['op']
    if op=='retrospective_query':
        if records is not None:records.db.execute('BEGIN')
        return query(records,request)
    require(records is not None,'RETRO_STORE_UNAVAILABLE')
    key=_identifier(request.get('id'))
    if op=='retrospective_put':
        version=request.get('expectedVersion',0);require(type(version) is int and 0<=version<100,'RETRO_VERSION')
        chain=history(records,key,version=version) if version else [];previous=chain[-1] if chain else None
        require(version==0 or previous is not None and reference(previous)==request.get('binding'),'RETRO_BINDING_STALE')
        # An identical retry uses the frozen original capture; it cannot acquire a different selection silently.
        retry=records.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? AND record_id=? AND request_id=?',(records.memory.scope,rid(records.memory.scope,key),request.get('requestId'))).fetchone()
        frozen=records._envelope(retry)['payload']['retrospective']['capture'] if retry else None
        payload=compile_record(records,key,request.get('detail'),previous,frozen)
        return public(records,records.put(payload,expected_version=version,request_id=request.get('requestId')))
    require(op in ('retrospective_get','retrospective_history'),'RETRO_OPERATION');records.db.execute('BEGIN')
    chain=history(records,key,request.get('knownAt'),request.get('version'));require(chain,'RETRO_NOT_AT_CUT')
    if request.get('version') is not None:require(chain[-1]['version']==request['version'],'RETRO_NOT_AT_CUT')
    return [public(records,r) for r in chain] if op=='retrospective_history' else public(records,chain[-1])
