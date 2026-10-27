"""Versioned n-ary contexts. Membership never implies pairwise edges or AND.

Originals remain in AFH; N04 stores exact references, literal witnesses and an
append-only interpretation. Indexed keyset pages are explicit, bounded cuts.
"""
import copy, hashlib, json, re
from datetime import datetime, timezone, timedelta
from .knowledge_records import KnowledgeRecords, RecordError, _identifier, _json, _text
from .relational_memory import instant
from .learning import packet_bytes

SCHEMA = 'afh.collective.v1'
POLICY = dict(semanticSupport='not_reviewed', humanAcceptance=False,
              executionAuthority=False, membershipLogic='none', binaryEdges=[])

def require(ok, code):
    if not ok: raise RecordError(code)

def digest(value): return hashlib.sha256(_json(value).encode('utf8')).hexdigest()
def now(): return datetime.now(timezone.utc).isoformat(timespec='microseconds')
def sql_cut(value):
    return (datetime(1970,1,1,tzinfo=timezone.utc)+timedelta(microseconds=instant(value)//1000)).isoformat(timespec='microseconds')
def work(records):
    records._collective_work=getattr(records,'_collective_work',0)+1
    require(records._collective_work<=2000,'COLLECTIVE_WORK_BUDGET')
def rid(scope, key): return 'collective-'+digest([scope, _identifier(key)])[:48]
def reference(record):
    return dict(id=record['payload']['collective']['id'], version=record['version'], digest=digest(record))

def temporal(value, witness):
    require(isinstance(value,dict) and set(value)=={'eventAt','validFrom','validTo','endOpen','evidence'}, 'COLLECTIVE_TIME_REQUIRED')
    require(type(value['endOpen']) is bool, 'INVALID_END_OPEN')
    for key in ('eventAt','validFrom','validTo'):
        if value[key] is not None: instant(value[key])
    require(not(value['endOpen'] and value['validTo'] is not None),'INVALID_TEMPORAL_RANGE')
    if value['validFrom'] is not None and value['validTo'] is not None:
        require(instant(value['validFrom'])<instant(value['validTo']),'INVALID_TEMPORAL_RANGE')
    stated=any(value[k] is not None for k in ('eventAt','validFrom','validTo')) or value['endOpen']
    if stated: witness(value['evidence'],'temporal')
    else: require(value['evidence']==[],'UNKNOWN_TIME_EVIDENCE')

def validity(value, at):
    point=instant(at)
    if value['validFrom'] is not None and point<instant(value['validFrom']): return 'outside'
    if value['validTo'] is not None and point>=instant(value['validTo']): return 'outside'
    if value['validFrom'] is None or (value['validTo'] is None and not value['endOpen']): return 'unknown'
    return 'within_declared_interval'

def history(records, key, *, known_at=None, stack=()):
    _identifier(key)
    if known_at is not None: instant(known_at)
    rows=records.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? AND record_id=? ORDER BY version LIMIT 101',
                            (records.memory.scope,rid(records.memory.scope,key))).fetchall()
    # Verify no future payloads or sources for a historical cut.
    if known_at is not None: rows=[r for r in rows if instant(r['recorded_at'])<=instant(known_at)]
    require(len(rows)<=100,'COLLECTIVE_HISTORY_BUDGET')
    previous=None; result=[]
    for row in rows:
        work(records)
        record=records._envelope(row); c=record['payload'].get('collective')
        require(record['integrity']=='envelope_v1' and isinstance(c,dict) and c.get('schema')==SCHEMA,'COLLECTIVE_SCHEMA')
        require(record['version']==len(result)+1,'COLLECTIVE_CHAIN_GAP')
        expected=compile_relation(records,key,c['detail'],previous,stack=stack)
        require(record['payload']==expected,'COLLECTIVE_BINDING')
        result.append(record);previous=record
    return result

def resolve_target(records,target,stack=()):
    """Resolve an exact version, never silently substitute a newer one."""
    from .host import AFHMemory
    work(records)
    require(isinstance(target,dict),'TARGET_REQUIRED')
    kind=target.get('kind'); _identifier(target.get('id'))
    if kind=='source':
        require(set(target)=={'kind','id','revision'},'TARGET_SHAPE')
        source=records._source(target,records.memory.scope)
        return [dict(id=source['id'],revision=source['revision'])]
    require(kind in ('collective','record') and set(target)=={'kind','id','version','digest'},'TARGET_SHAPE')
    require(type(target['version']) is int and target['version']>0,'INVALID_TARGET_VERSION')
    token=(kind,target['id'],target['version']);require(token not in stack,'COLLECTIVE_CYCLE')
    require(len(stack)<12,'COLLECTIVE_DEPTH_BUDGET')
    if kind=='collective':
        # An exact version needs only its preceding chain. Later revisions may
        # use sources outside this historical selection and are not evidence here.
        row=records.db.execute('SELECT recorded_at FROM record_versions WHERE scope=? AND record_id=? AND version=?',
            (records.memory.scope,rid(records.memory.scope,target['id']),target['version'])).fetchone()
        require(row is not None,'TARGET_NOT_FOUND')
        chain=history(records,target['id'],known_at=row['recorded_at'],stack=stack+(token,))
        r=next((r for r in chain if r['version']==target['version']),None)
    else:
        root=records.memory.path.parent.parent
        require((root/'records.sqlite3').is_file(),'TARGET_NOT_FOUND')
        memory=AFHMemory(root,list(records.memory.sources.values()),records.memory.scope)
        foreign=KnowledgeRecords(memory,root/'records.sqlite3')
        try:
            row=foreign.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? AND record_id=? AND version=?',
                (records.memory.scope,target['id'],target['version'])).fetchone()
            require(row is not None,'TARGET_NOT_FOUND');r=foreign._envelope(row)
            require(r['integrity']=='envelope_v1','TARGET_ENVELOPE_REQUIRED')
        finally: foreign.close();memory.close()
    require(r is not None and digest(r)==target['digest'],'TARGET_DIGEST_MISMATCH')
    return r['payload']['source_refs']

def compile_relation(records,key,detail,previous,*,stack=()):
    from .host import ref
    require(isinstance(detail,dict) and len(_json(detail).encode())<=50000,'COLLECTIVE_INPUT_BUDGET')
    detail=copy.deepcopy(detail)
    require(set(detail)=={'title','kind','scope','participants','conditions','temporal','state','negated','classification','evidence','actor','reason'},'COLLECTIVE_FIELDS')
    for field,limit in (('title',500),('kind',128),('scope',2000),('actor',128),('reason',2000)):
        _text(detail.get(field),field,limit)
    require(detail['state'] in ('active','disputed','withdrawn'),'INVALID_COLLECTIVE_STATE')
    require(detail['classification'] in ('explicit','inferred') and type(detail['negated']) is bool,'COLLECTIVE_CLASSIFICATION')
    refs={};bindings={}
    def witnesses(items,field):
        require(isinstance(items,list) and 1<=len(items)<=8,'COLLECTIVE_EVIDENCE_REQUIRED:'+field)
        values=[]
        for item in items:
            require(isinstance(item,dict),'INVALID_WITNESS')
            r=ref(records.memory,item.get('sourceId'),item.get('quote'),item.get('start'))
            e=records._source(r,records.memory.scope);refs[r['id']]=dict(id=r['id'],revision=r['revision'])
            values.append({**r,'sourceRole':e['role'],'occurrenceId':e['occurrence_id'],'support':'literal_quote_only'})
        bindings[field]=values
    witnesses(detail['evidence'],'description_and_scope')
    participants=detail['participants'];require(isinstance(participants,list) and 2<=len(participants)<=40,'PARTICIPANTS_REQUIRED')
    keys=[]
    for i,p in enumerate(participants):
        require(isinstance(p,dict) and set(p)=={'target','role','label','evidence'},'PARTICIPANT_FIELDS')
        _text(p['role'],'role',128);_text(p['label'],'label',500)
        keys.append((digest(p['target']),p['role']))
        for r in resolve_target(records,p['target'],stack): refs[r['id']]=dict(id=r['id'],revision=r['revision'])
        witnesses(p['evidence'],'participants/'+str(i))
    require(len(keys)==len(set(keys)),'DUPLICATE_PARTICIPATION')
    require(len({k[0] for k in keys})>=2,'DISTINCT_PARTICIPANTS_REQUIRED')
    conditions=detail['conditions'];require(isinstance(conditions,list) and len(conditions)<=20,'INVALID_CONDITIONS')
    for i,c in enumerate(conditions):
        require(isinstance(c,dict) and set(c)=={'text','evidence'},'CONDITION_FIELDS')
        _text(c['text'],'condition',2000);witnesses(c['evidence'],'conditions/'+str(i))
    temporal(detail['temporal'],witnesses);require(len(refs)<=20,'COLLECTIVE_SOURCE_BUDGET')
    c=dict(schema=SCHEMA,id=key,detail=detail,bindings=bindings,previous=reference(previous) if previous else None,**POLICY)
    return dict(id=rid(records.memory.scope,key),scope=records.memory.scope,type='collective_relation',text=detail['title'],
                actor=dict(id=detail['actor'],role='user'),modality='inferred' if detail['classification']=='inferred' else 'stated',
                status='proposed',source_refs=[refs[k] for k in sorted(refs)],collective=c)

def public(records,record,at):
    c=record['payload']['collective'];d=c['detail'];v=validity(d['temporal'],at)
    stale=[]
    for r in record['payload']['source_refs']:
        s=records.memory.sources[r['id']]
        if s.get('document',{}).get('currentRevision') is False: stale.append(r['id'])
    return dict(reference=reference(record),record=record,validAt=at,validity=v,historicalSources=stale,
                requiresReview=True,limits='Literal provenance only; declared interval is not verified truth. Membership implies no binary edges or conjunction.')

def dispatch_collective(records,request):
    records._collective_work=0
    op=request['op'];scope=records.memory.scope
    if op=='collective_put':
        key=_identifier(request.get('id'));version=request.get('expectedVersion',0)
        require(type(version) is int and version>=0,'INVALID_VERSION')
        chain=history(records,key);previous=next((r for r in chain if r['version']==version),None)
        require(version==0 or previous is not None,'VERSION_CONFLICT')
        require(len(chain)<100 or any(r['version']==version+1 for r in chain),'COLLECTIVE_HISTORY_BUDGET')
        if version: require(request.get('binding')==reference(previous),'COLLECTIVE_BINDING_STALE')
        payload=compile_relation(records,key,request.get('detail'),previous)
        r=records.put(payload,expected_version=version,request_id=request.get('requestId'))
        return public(records,r,request.get('validAt') or now())
    at=request.get('validAt') or now();instant(at)
    known=request.get('knownAt');
    if known is not None: instant(known)
    records.db.execute('BEGIN')
    if op in ('collective_get','collective_history'):
        version=request.get('version');require(version is None or type(version) is int and version>0,'INVALID_VERSION')
        if op=='collective_get' and version is not None:
            row=records.db.execute('SELECT recorded_at FROM record_versions WHERE scope=? AND record_id=? AND version=?',(scope,rid(scope,request.get('id')),version)).fetchone()
            require(row is not None and (known is None or instant(row['recorded_at'])<=instant(known)),'COLLECTIVE_VERSION_NOT_FOUND')
            known=row['recorded_at']
        chain=history(records,request.get('id'),known_at=known);require(bool(chain),'COLLECTIVE_NOT_FOUND')
        if op=='collective_history':
            result=[public(records,r,at) for r in chain];require(len(_json(result).encode())<=4_000_000,'COLLECTIVE_HISTORY_RESPONSE_BUDGET');return result
        r=next((r for r in chain if r['version']==version),None) if version is not None else chain[-1]
        require(r is not None,'COLLECTIVE_VERSION_NOT_FOUND');return public(records,r,at)
    require(op=='collective_query','UNKNOWN_COLLECTIVE_OPERATION')
    limit=request.get('limit',20);maximum=request.get('maxBytes',100000)
    require(type(limit) is int and 1<=limit<=50,'COLLECTIVE_LIMIT')
    require(type(maximum) is int and 4096<=maximum<=100000,'COLLECTIVE_PACKET_BUDGET')
    question=request.get('question','');require(isinstance(question,str) and len(question)<=4000,'INVALID_QUESTION')
    role=request.get('role');target=request.get('targetId')
    if role is not None:_text(role,'role',128)
    if target is not None:_identifier(target)
    selection=digest(sorted((s['id'],s['revision'],s.get('document')) for s in records.memory.sources.values()))
    query=dict(scope=scope,question=question,role=role,targetId=target,selection=selection,requestedKnownAt=known,requestedValidAt=request.get('validAt'))
    cursor=request.get('cursor');after=''
    if cursor is not None:
        require(isinstance(cursor,dict) and set(cursor)=={'after','knownAt','validAt','query'},'INVALID_CURSOR')
        require(cursor['query']==digest(query),'CURSOR_QUERY_MISMATCH');after=cursor['after'];_identifier(after)
        known=cursor['knownAt'];at=cursor['validAt'];instant(known);instant(at)
    else: known=known or now()
    # Scope + time index narrows the historical cut; keyset avoids deep OFFSET.
    rows=records.db.execute('SELECT record_id FROM record_versions WHERE scope=? AND record_id>? AND recorded_at<=? GROUP BY record_id ORDER BY record_id LIMIT 51',
                            (scope,after,sql_cut(known))).fetchall()
    packet=dict(schema='afh.collective-page.v1',items=[],errors=[],outsideSelection=0,scanned=0,nextCursor=None,
                knownAt=known,validAt=at,selection=selection,maxBytes=maximum,coverage='One bounded page of selected source-backed interpretations; no global absence claim.',
                membershipLogic='none',binaryEdges=[],status='complete_page')
    tokens=set(re.findall(r'\w+',question.casefold()));last=after;has_more=False
    for row in rows[:50]:
        key=row['record_id'];chain_rows=records.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? AND record_id=? AND recorded_at<=? ORDER BY version LIMIT 101',(scope,key,sql_cut(known))).fetchall()
        try:
            # Verify envelopes before consulting the payload's public ID.
            raw=records._envelope(chain_rows[-1],verify_sources=False)
            if any(not records.memory.source_eligible(s['id'],scope) for s in raw['payload']['source_refs']):
                packet['outsideSelection']+=1
            else:
                chain=history(records,raw['payload']['collective']['id'],known_at=known);r=chain[-1];d=r['payload']['collective']['detail']
                matched=(not tokens or tokens.intersection(re.findall(r'\w+',_json(d).casefold()))) and any((role is None or p['role']==role) and (target is None or p['target']['id']==target) for p in d['participants'])
                if matched:
                    packet['items'].append(public(records,r,at))
                    if packet_bytes(packet)>maximum-1500:
                        packet['items'].pop()
                        require(last!=after or packet['scanned']>0,'COLLECTIVE_ITEM_EXCEEDS_BUDGET')
                        has_more=True;break
        except RecordError as e:
            if str(e)=='COLLECTIVE_ITEM_EXCEEDS_BUDGET': raise
            packet['errors'].append(dict(recordId=key,error=str(e)))
        last=key;packet['scanned']+=1
        if len(packet['items'])>=limit: has_more=True;break
    has_more=has_more or len(rows)>50
    if has_more and last:packet['nextCursor']=dict(after=last,knownAt=known,validAt=at,query=digest(query))
    if packet['errors']: packet['items']=[];packet['status']='incomplete'
    elif packet['outsideSelection']:packet['status']='partial_selection'
    require(packet_bytes(packet)<=maximum,'COLLECTIVE_PACKET_BUDGET');return packet
