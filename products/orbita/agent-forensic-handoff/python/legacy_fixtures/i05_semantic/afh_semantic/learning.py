"""F25 source-bound learning episodes on the existing N04 record engine.

The dedicated namespace isolates episodes from semantic-act extraction. No
Controller, execution, model call, approval or inferred universal applicability.
"""
import copy, hashlib, json, re
from .knowledge_records import RecordError, _json, _identifier, _text
from .relational_memory import instant

SCHEMA = 'afh.learning-episode.v1'
CLAIMS = ('condition', 'action', 'failure', 'observation', 'repair', 'hypothesis', 'procedure')
REQUIRED = ('condition', 'action', 'observation')
POLICY = {'epistemicStatus':'reported_observation', 'hypothesisStatus':'hypothesis',
          'procedureStatus':'proposal', 'humanAcceptance':False, 'executionAuthority':False,
          'applicability':'requires_case_review', 'identityBasis':'local_declaration_not_authenticated'}

def require(ok, code):
    if not ok: raise RecordError(code)

def record_id(scope, eid):
    _identifier(eid)
    return 'learn-' + hashlib.sha256(_json([scope,eid]).encode()).hexdigest()[:48]

def compile_episode(records, episode, actor, reason):
    from .host import ref
    require(isinstance(episode,dict), 'LEARNING_EPISODE_REQUIRED')
    require(len(_json(episode).encode('utf8'))<=60000,'LEARNING_INPUT_BUDGET')
    episode=copy.deepcopy(episode); _identifier(episode.get('id')); _text(episode.get('title'),'title',500)
    # Unknown fields remain historical data, never policy overrides.
    require(not set(episode).intersection(POLICY),'LEARNING_RESERVED_POLICY')
    bindings={}; refs={}
    def witnesses(items):
        require(isinstance(items,list) and 1<=len(items)<=8,'LEARNING_EVIDENCE_REQUIRED')
        result=[]
        for item in items:
            require(isinstance(item,dict),'LEARNING_EVIDENCE_INVALID')
            r=ref(records.memory,item.get('sourceId'),item.get('quote'),item.get('start'))
            e=records._source(r, records.memory.scope)
            refs[r['id']]={'id':r['id'],'revision':r['revision']}
            result.append({**r,'sourceRole':e['role'],'sourceConversationId':e['source_conversation_id'],
                           'occurrenceId':e['occurrence_id'],'support':'literal_quote_only'})
        return result
    def claim(value,key):
        require(isinstance(value,dict),'LEARNING_CLAIM_REQUIRED:'+key)
        _text(value.get('text'),key,8000); bindings[key]=witnesses(value.get('evidence'))
    for field in CLAIMS:
        value=episode.get(field)
        if field in REQUIRED or value is not None: claim(value,field)
    outcome=episode.get('outcome');require(isinstance(outcome,dict) and outcome.get('value') in ('success','failure','unknown'),'LEARNING_OUTCOME')
    bindings['outcome']=witnesses(outcome.get('evidence'))
    counter=episode.get('counterexamples');require(isinstance(counter,list) and len(counter)<=12,'LEARNING_COUNTEREXAMPLES')
    for i,value in enumerate(counter): claim(value,'counterexamples/'+str(i))
    require(len(refs)<=20,'LEARNING_SOURCE_BUDGET')
    _text(actor,'actor',128); _text(reason,'reason',2000)
    learning={'schema':SCHEMA,'episode':episode,'bindings':bindings,**POLICY,
              'counterexamplesStatus':'recorded' if counter else 'not_recorded_not_proven_absent',
              'originConversations':sorted({w['sourceConversationId'] for ws in bindings.values() for w in ws}),
              'changeReason':reason}
    return {'id':record_id(records.memory.scope,episode['id']),'scope':records.memory.scope,
            'type':'learning_episode','text':episode['title'],'actor':{'id':actor,'role':'agent'},
            'modality':'stated','status':'proposed','source_refs':[refs[k] for k in sorted(refs)],'learning_episode':learning}

def verified_record(records, record):
    p=record['payload']; learning=p.get('learning_episode')
    require(isinstance(learning,dict) and learning.get('schema')==SCHEMA,'LEARNING_RECORD_SCHEMA')
    expected=compile_episode(records,learning['episode'],p['actor']['id'],learning['changeReason'])
    require(expected==p,'LEARNING_RECORD_BINDING')
    require(record['integrity']=='envelope_v1','LEARNING_ENVELOPE_REQUIRED')
    return record

def packet_bytes(packet):
    # Match the actual compact bridge serialization; JS re-measures after binding.
    packet['bytes']=0
    for _ in range(8):
        n=len(json.dumps(packet,ensure_ascii=False,separators=(',',':')).encode('utf8'))
        if packet['bytes']==n: return n
        packet['bytes']=n
    raise RecordError('LEARNING_BYTE_ACCOUNTING')

def dispatch_learning(records, request):
    op=request['op'];scope=request['scope']
    if op=='learning_record':
        version=request.get('expectedVersion',0);require(type(version) is int and version>=0,'INVALID_VERSION')
        reason=request.get('reason','initial recording' if version==0 else None)
        payload=compile_episode(records,request.get('episode'),request.get('actor','local-editor'),reason)
        if version:
            previous=verified_record(records,records.get(payload['id'],scope,version=version))
            require(not(set(previous['payload']['learning_episode']['episode'])-set(request['episode'])),'LEARNING_FIELDS_REMOVED')
        result=records.put(payload,expected_version=version,request_id=request['requestId'])
        return verified_record(records,result)
    if op in ('learning_get','learning_history'):
        rid=record_id(scope,request['id'])
        if op=='learning_get': return verified_record(records,records.get(rid,scope,version=request.get('version')))
        return [verified_record(records,r) for r in records.history(rid,scope)]
    require(op=='learning_query','UNKNOWN_LEARNING_OPERATION')
    question=request.get('question');_text(question,'question',8000)
    limit=request.get('limit',20);require(type(limit) is int and 1<=limit<=50,'LEARNING_LIMIT')
    max_bytes=request.get('maxBytes',100000);require(type(max_bytes) is int and 4096<=max_bytes<=100000,'LEARNING_PACKET_BUDGET')
    known_at=request.get('knownAt')
    if known_at is not None:instant(known_at)
    # The complete bounded version scan verifies envelopes before filtering.
    # Corruption and unavailable selected sources never become a valid empty hit.
    records.db.execute('BEGIN')
    rows=records.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? ORDER BY record_id,version LIMIT 2001',(scope,)).fetchall()
    require(len(rows)<=2000,'LEARNING_ARCHIVE_BUDGET')
    latest={};errors=[]
    for row in rows:
        try:
            record=records._envelope(row,verify_sources=False)
            require(record['integrity']=='envelope_v1','LEARNING_ENVELOPE_REQUIRED')
            p=record['payload'];l=p.get('learning_episode',{})
            require(l.get('schema')==SCHEMA and all(l.get(k)==v for k,v in POLICY.items()),'LEARNING_RECORD_SCHEMA')
            require(record_id(scope,l['episode']['id'])==record['id'],'LEARNING_ID_BINDING')
            if known_at is None or instant(record['recorded_at'])<=instant(known_at): latest[record['id']]=record
        except (RecordError,ValueError,KeyError,TypeError) as error:
            errors.append({'recordId':row['record_id'],'version':row['version'],'error':str(error)})
    tokens=set(re.findall(r'\w+',question.casefold()));matches=[];outside=0
    for record in latest.values():
        if any(not records.memory.source_eligible(r['id'],scope) for r in record['payload']['source_refs']):
            outside+=1;continue
        try:
            verified_record(records,record)
            episode=record['payload']['learning_episode']['episode']
            texts=[episode['title'],*[episode[k]['text'] for k in CLAIMS if episode.get(k)],*[v['text'] for v in episode['counterexamples']]]
            words=set(re.findall(r'\w+',' '.join(texts).casefold()));score=len(tokens.intersection(words))
            if score:matches.append((score,record))
        except (RecordError,ValueError,KeyError,TypeError) as error:
            errors.append({'recordId':record['id'],'version':record['version'],'error':str(error)})
    matches.sort(key=lambda x:(-x[0],x[1]['id']))
    packet={'schema':'afh.learning-context.v1','scope':scope,'question':question,'knownAt':known_at,
            'items':[],'errors':errors,'matches':len(matches),'omittedByLimit':max(0,len(matches)-limit),
            'omittedByBudget':0,'outsideSelection':outside,'maxBytes':max_bytes,'status':'incomplete' if errors else 'no_precedent_found',
            'authority':'Discovery only; no execution or permission. Conditions require case-specific review.',
            'coverage':'Literal term overlap over selected source-backed episodes; missing results do not prove absence.',
            'semanticSupport':'not_reviewed','requiresCaseReview':True}
    # Fail closed on any corrupted envelope, even in an unrelated old version.
    if not errors:
        for score,record in matches[:limit]:
            item={'record':record,'matchTerms':score};packet['items'].append(item)
            if packet_bytes(packet)>max_bytes:packet['items'].pop();packet['omittedByBudget']+=1
        packet['status']='episodes_found' if packet['items'] else ('omitted' if matches else 'no_precedent_found')
        if outside:packet['status']='partial_selection'
    require(packet_bytes(packet)<=max_bytes,'LEARNING_PACKET_BUDGET')
    return packet
