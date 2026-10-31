"""F28: source-bound identity declarations and reversible, versioned reviews.

Groups are a derived view. No original/semantic ID is rewritten or deleted.
Name similarity proposes a comparison; it never establishes an identity.
"""
import copy, re, unicodedata
from .knowledge_records import KnowledgeRecords, _identifier, _text, _json
from .collectives import require, digest, now, sql_cut, temporal, validity
from .relational_memory import instant

SCHEMA='afh.identity.v1'
POLICY=dict(humanAcceptance=False,executionAuthority=False,truth='not_established',
            identityBasis='source_bound_local_declaration_not_authenticated',independentCorroboration='not_established')
def normalized(value):
    return ' '.join(re.sub(r'[^\w]+',' ',''.join(c for c in unicodedata.normalize('NFD',value.casefold()) if not unicodedata.combining(c))).split())
def rid(scope,kind,key):return 'identity-'+digest([scope,kind,_identifier(key)])[:48]
def reference(record):return dict(id=record['payload']['identity']['id'],version=record['version'],digest=digest(record))
def tick(records):
    records._identity_work=getattr(records,'_identity_work',0)+1
    require(records._identity_work<=12000,'IDENTITY_WORK_BUDGET')
def source_refs(values):return list({(r['id'],r['revision']):r for value in values for r in value}.values())

def origin_record(records,origin):
    from .host import AFHMemory
    require(isinstance(origin,dict) and set(origin)=={'id','version','digest','mentionId'},'IDENTITY_ORIGIN_FIELDS')
    _identifier(origin['id']);_identifier(origin['mentionId']);require(type(origin['version']) is int and origin['version']>0,'IDENTITY_ORIGIN_VERSION')
    root=records.memory.path.parent.parent;require((root/'records.sqlite3').exists(),'IDENTITY_ORIGIN_UNAVAILABLE')
    memory=AFHMemory(root,list(records.memory.sources.values()),records.memory.scope)
    foreign=KnowledgeRecords(memory,root/'records.sqlite3',read_only=True)
    try:
        row=foreign.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? AND record_id=? AND version=?',(records.memory.scope,origin['id'],origin['version'])).fetchone()
        require(row is not None,'IDENTITY_ORIGIN_UNAVAILABLE');record=foreign._envelope(row)
        require(record['integrity']=='envelope_v1' and digest(record)==origin['digest'],'IDENTITY_ORIGIN_DIGEST')
        mention=next((m for m in record['payload'].get('afh_mentions',[]) if m['id']==origin['mentionId']),None)
        require(mention is not None,'IDENTITY_ORIGIN_MENTION')
        return record,mention
    finally:foreign.close();memory.close()

def compile_record(records,kind,key,detail,previous):
    from .host import ref
    tick(records);require(kind in ('entity','link'),'IDENTITY_KIND')
    require(isinstance(detail,dict) and len(_json(detail).encode())<=60000,'IDENTITY_INPUT_BUDGET')
    d=copy.deepcopy(detail);common={'state','actor','reason','evidence'}
    fields=common|({'label','aliases','entityType','namespace','origin'} if kind=='entity' else {'left','right','judgment','temporal'})
    require(set(d)==fields,'IDENTITY_FIELDS')
    _text(d['actor'],'actor',128);_text(d['reason'],'reason',2000);require(d['state'] in ('active','withdrawn'),'IDENTITY_STATE')
    refs={};bindings={}
    def witnesses(items,field):
        require(isinstance(items,list) and 1<=len(items)<=8,'IDENTITY_EVIDENCE_REQUIRED')
        bound=[]
        for item in items:
            require(isinstance(item,dict) and set(item)<= {'sourceId','quote','start'},'IDENTITY_EVIDENCE_FIELDS')
            r=ref(records.memory,item.get('sourceId'),item.get('quote'),item.get('start'));e=records.memory.evidence(r['id'])
            refs[r['id']]=dict(id=r['id'],revision=r['revision']);bound.append({**r,'occurrenceId':e['occurrence_id'],'role':e['role']})
        bindings[field]=bound
    witnesses(d['evidence'],'declaration')
    if kind=='entity':
        for field,limit in [('label',300),('entityType',128),('namespace',500)]:_text(d[field],field,limit)
        require(isinstance(d['aliases'],list) and len(d['aliases'])<=10,'IDENTITY_ALIASES')
        for alias in d['aliases']:_text(alias,'alias',300)
        names=[d['label'],*d['aliases']];require(len(set(names))==len(names),'IDENTITY_DUPLICATE_ALIAS')
        require(all(any(name in w['quote'] for w in bindings['declaration']) for name in names),'IDENTITY_NAME_NOT_LITERAL')
        if previous:
            old=previous['payload']['identity']['detail']
            require((old['entityType'],old['namespace'])==(d['entityType'],d['namespace']),'IDENTITY_SCOPE_TYPE_IMMUTABLE')
        if d['origin'] is not None:
            origin,mention=origin_record(records,d['origin']);require(mention['literal']==d['label'],'IDENTITY_ORIGIN_LABEL')
            for r in origin['payload']['source_refs']:refs[r['id']]=r
    else:
        require(d['judgment'] in ('same','different','uncertain'),'IDENTITY_JUDGMENT')
        require(isinstance(d['left'],dict) and isinstance(d['right'],dict),'IDENTITY_TARGET_REQUIRED')
        require(d['left']['id']!=d['right']['id'],'IDENTITY_SELF_LINK')
        if d['left']['id']>d['right']['id']:d['left'],d['right']=d['right'],d['left']
        entities=[exact_entity(records,d[side]) for side in ('left','right')]
        a,b=[e['payload']['identity']['detail'] for e in entities]
        require(a['namespace']==b['namespace'],'IDENTITY_NAMESPACE_MISMATCH')
        if d['judgment']=='same':require(a['entityType']==b['entityType'],'IDENTITY_TYPE_MISMATCH')
        require(key=='pair-'+digest([d['left']['id'],d['right']['id']])[:40],'IDENTITY_PAIR_KEY')
        for e in entities:
            for r in e['payload']['source_refs']:refs[r['id']]=r
        temporal(d['temporal'],witnesses)
    require(len(refs)<=40,'IDENTITY_SOURCE_BUDGET')
    value=dict(schema=SCHEMA,kind=kind,id=key,detail=d,bindings=bindings,previous=reference(previous) if previous else None,**POLICY)
    return dict(id=rid(records.memory.scope,kind,key),scope=records.memory.scope,type='entity_identity' if kind=='entity' else 'identity_review',text=d.get('label',d.get('judgment')),actor=dict(id=d['actor'],role='user'),modality='stated',status='proposed',source_refs=[refs[k] for k in sorted(refs)],identity=value)

def history(records,kind,key,known=None):
    _identifier(key)
    if known is not None:instant(known)
    cache=getattr(records,'_identity_cache',None)
    if cache is None:records._identity_cache={};cache=records._identity_cache
    token=(kind,key,known)
    if token in cache:return cache[token]
    rows=records.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? AND record_id=? AND recorded_at<=? ORDER BY version LIMIT 101',(records.memory.scope,rid(records.memory.scope,kind,key),sql_cut(known or '9999-01-01T00:00:00Z'))).fetchall()
    require(len(rows)<=100,'IDENTITY_HISTORY_BUDGET');chain=[]
    for row in rows:
        tick(records);record=records._envelope(row);value=record['payload'].get('identity',{})
        require(record['integrity']=='envelope_v1' and value.get('schema')==SCHEMA and value.get('kind')==kind and value.get('id')==key,'IDENTITY_SCHEMA')
        require(record['version']==len(chain)+1,'IDENTITY_CHAIN_GAP')
        expected=compile_record(records,kind,key,value['detail'],chain[-1] if chain else None)
        require(expected==record['payload'],'IDENTITY_BINDING');chain.append(record)
    cache[token]=chain;return chain

def exact_entity(records,ref):
    require(isinstance(ref,dict) and set(ref)=={'id','version','digest'},'IDENTITY_REFERENCE_FIELDS')
    require(type(ref['version']) is int and ref['version']>0,'IDENTITY_REFERENCE_VERSION')
    row=records.db.execute('SELECT recorded_at FROM record_versions WHERE scope=? AND record_id=? AND version=?',(records.memory.scope,rid(records.memory.scope,'entity',ref['id']),ref['version'])).fetchone()
    require(row is not None,'IDENTITY_ENTITY_NOT_FOUND')
    chain=history(records,'entity',ref['id'],row['recorded_at']);record=chain[-1]
    require(reference(record)==ref,'IDENTITY_REFERENCE_CHANGED');return record

def public(record):return dict(reference=reference(record),kind=record['payload']['identity']['kind'],record=record,**POLICY)

def semantic_mentions(request):
    from .context_retrieval import store,heads
    known=request.get('knownAt') or now();instant(known);items=[];outside=0
    with store(request) as records:
        if records is not None:
            for row in heads(records,known):
                record=records._envelope(row,verify_sources=False)
                if any(not records.memory.source_eligible(r['id'],request['scope']) for r in record['payload']['source_refs']):outside+=1;continue
                record=records._envelope(row)
                for m in record['payload'].get('afh_mentions',[]):
                    items.append(dict(label=m['literal'],role=m['role'],entityCandidateId=m['entity_candidate_id'],origin=dict(id=record['id'],version=record['version'],digest=digest(record),mentionId=m['id']),evidence=[dict(sourceId=w['source_id'],quote=w['quote'],start=w['locator']['start']) for w in m['source_refs']],equivalence='candidate_only_no_merge'))
                    require(len(items)<=1000,'IDENTITY_MENTION_BUDGET')
    return dict(items=items,knownAt=known,outsideSelection=outside,**POLICY)

def resolve(records,request):
    known=request.get('knownAt') or now();at=request.get('validAt') or known;instant(known);instant(at)
    mode=request.get('mode') or ('historical' if request.get('knownAt') else 'current')
    result=dict(schema='afh.identity-resolution.v1',knownAt=known,validAt=at,mode=mode,entities=[],links=[],groups=[],candidates=[],outsideSelection=0,coverage='all_admitted_heads_within_selected_sources_and_limits',**POLICY)
    if records is None:return result
    from .context_retrieval import heads
    entities={};links=[];excluded=[]
    for row in heads(records,known,1000):
        raw=records._envelope(row,verify_sources=False);value=raw['payload'].get('identity',{});require(value.get('schema')==SCHEMA,'IDENTITY_SCHEMA')
        if any(not records.memory.source_eligible(r['id'],request['scope']) for r in raw['payload']['source_refs']):
            result['outsideSelection']+=1
            if value['kind']=='link':excluded.append(value['detail'])
            continue
        record=history(records,value['kind'],value['id'],known)[-1];item=public(record);d=record['payload']['identity']['detail']
        item.update(label=d.get('label'),state=d['state'],sourceRefs=record['payload']['source_refs'])
        if value['kind']=='entity':
            reasons=[]
            if d['state']!='active':reasons.append('entity_withdrawn')
            if mode=='current' and any(records.memory.sources[r['id']].get('document',{}).get('currentRevision') is False for r in item['sourceRefs']):reasons.append('historical_source')
            if d['origin']:
                from .context_retrieval import store
                with store(request) as foreign:
                    latest=foreign.db.execute('SELECT MAX(version) FROM record_versions WHERE scope=? AND record_id=? AND recorded_at<=?',(request['scope'],d['origin']['id'],sql_cut(known))).fetchone()[0]
                    if latest!=d['origin']['version']:reasons.append('semantic_revision_changed')
            item.update(aliases=d['aliases'],entityType=d['entityType'],namespace=d['namespace'],reasons=reasons,eligible=not reasons,canonicalId=value['id'])
            entities[value['id']]=item
        else:links.append(item)
    for d in excluded:
        if d['state']=='active':
            for side in ('left','right'):
                if d[side]['id'] in entities:
                    e=entities[d[side]['id']];e['eligible']=False;e['reasons'].append('comparison_outside_selection')
    parent={key:key for key in entities}
    def find(k):
        while parent[k]!=k:parent[k]=parent[parent[k]];k=parent[k]
        return k
    def union(a,b):
        a,b=find(a),find(b)
        if a!=b:parent[max(a,b)]=min(a,b)
    constraints=[]
    for link in links:
        d=link['record']['payload']['identity']['detail'];left,right=[entities.get(d[k]['id']) for k in ('left','right')];reasons=[]
        if d['state']=='withdrawn':reasons.append('review_withdrawn')
        if mode=='current' and any(records.memory.sources[r['id']].get('document',{}).get('currentRevision') is False for r in link['sourceRefs']):reasons.append('historical_source')
        for side,e in [('left',left),('right',right)]:
            if e is None or e['reference']!=d[side]:reasons.append('entity_revision_changed')
            elif not e['eligible']:reasons.extend(e['reasons'])
        v=validity(d['temporal'],at)
        if v!='within_declared_interval':reasons.append('validity_'+v)
        link.update(left=d['left'],right=d['right'],judgment=d['judgment'],validity=v,reasons=sorted(set(reasons)),effective=False)
        exact=left is not None and right is not None and left['reference']==d['left'] and right['reference']==d['right']
        if d['judgment']=='same' and not reasons:
            union(d['left']['id'],d['right']['id']);link['effective']=True
        elif exact and d['state']=='active' and d['judgment'] in ('different','uncertain') and v!='outside':constraints.append(link)
    components={}
    for key,e in entities.items():components.setdefault(find(key),[]).append(e)
    for members in components.values():
        if len(members)<2:continue
        require(len(members)<=40,'IDENTITY_COMPONENT_BUDGET');ids={e['reference']['id'] for e in members}
        conflicting=[l for l in constraints if l['left']['id'] in ids and l['right']['id'] in ids]
        edges=[l for l in links if l['left']['id'] in ids and l['right']['id'] in ids]
        groupId='consolidation-'+digest(sorted(e['reference']['digest'] for e in members))[:32]
        status='conflict' if conflicting else 'declared_consolidation'
        if not conflicting:
            for e in members:e['canonicalId']=groupId
        else:
            for l in edges:l['effective']=False;l['reasons']=sorted(set(l['reasons']+['component_conflict']))
        refs=source_refs([e['sourceRefs'] for e in members]+[l['sourceRefs'] for l in edges])
        occurrences={records.memory.sources[r['id']]['occurrence_id'] for r in refs}
        result['groups'].append(dict(id=groupId,status=status,members=[e['reference'] for e in members],reviews=[l['reference'] for l in edges],conflicts=[l['reference'] for l in conflicting],sourceRefs=refs,distinctOriginalOccurrences=len(occurrences),independentCorroboration='not_established',requiresReview=True))
    buckets={};existing={(l['left']['id'],l['right']['id']) for l in links if l['state']=='active' and not any(r=='entity_revision_changed' for r in l['reasons'])};pairs=set()
    for key,e in entities.items():
        if e['state']!='active':continue
        for name in [e['label'],*e['aliases']]:
            n=normalized(name)
            if n:buckets.setdefault((e['namespace'],n),set()).add(key)
    for bucket in buckets.values():
        values=sorted(bucket);require(len(values)<=100,'IDENTITY_HOMONYM_BUDGET')
        for i,a in enumerate(values):
            for b in values[i+1:]:
                if (a,b) in existing or (a,b) in pairs:continue
                pairs.add((a,b));require(len(pairs)<=2000,'IDENTITY_CANDIDATE_BUDGET')
                result['candidates'].append(dict(id='candidate-'+digest([entities[a]['reference'],entities[b]['reference']])[:32],left=entities[a]['reference'],right=entities[b]['reference'],reason='literal_name_or_alias_match',typeConflict=entities[a]['entityType']!=entities[b]['entityType'],confidence='not_scored',identityEstablished=False))
    result['entities']=list(entities.values());result['links']=links;return result

def context_unit(board,question,discovered=(),hints=()):
    from .context_retrieval import words
    from .context_discovery import references_match
    question=' '.join([question,*hints])
    tokens=words(question);entities=board['entities'];query=' '+normalized(question)+' '
    hit={e['reference']['id'] for e in entities if tokens & words(' '.join([e['label'],*e['aliases']])) or any(normalized(name) and ' '+normalized(name)+' ' in query for name in [e['label'],*e['aliases']])}
    hit.update(e['reference']['id'] for e in entities if references_match(e['sourceRefs'],discovered))
    for link in board['links']:
        if references_match(link['sourceRefs'],discovered):hit.update((link['left']['id'],link['right']['id']))
    if not hit:return None
    # Close all explicit comparisons, including adverse/pending/withdrawn ones.
    changed=True
    while changed:
        before=set(hit)
        for link in board['links']:
            ids={link['left']['id'],link['right']['id']}
            if hit & ids:hit.update(ids)
        changed=hit!=before
    selected=[e for e in entities if e['reference']['id'] in hit];links=[l for l in board['links'] if l['left']['id'] in hit or l['right']['id'] in hit]
    require(len(selected)<=100 and len(links)<=300,'IDENTITY_CONTEXT_BUDGET')
    refs=source_refs([e['sourceRefs'] for e in selected]+[l['sourceRefs'] for l in links]);groups=[g for g in board['groups'] if any(m['id'] in hit for m in g['members'])]
    data=dict(entities=selected,links=links,groups=groups,candidates=[c for c in board['candidates'] if c['left']['id'] in hit and c['right']['id'] in hit],knownAt=board['knownAt'],validAt=board['validAt'],**POLICY)
    return dict(id='identity-context-'+digest(data)[:24],kind='identity',title='Identidades, alias y diferencias declaradas',sourceRefs=refs,needs=['source','antecedent','scope','validity','contradiction','revocation'],requiresReview=True,blocked=any('comparison_outside_selection' in e['reasons'] for e in selected),data=data)

def dispatch_identity(records,request):
    op=request['op'];known=request.get('knownAt');at=request.get('validAt') or known or now();instant(at)
    if op=='identity_resolve':
        if records is not None:records.db.execute('BEGIN')
        return resolve(records,request)
    require(records is not None,'IDENTITY_STORE_UNAVAILABLE')
    if op=='identity_put':
        kind=request.get('kind');detail=request.get('detail');require(kind in ('entity','link'),'IDENTITY_KIND')
        if kind=='link':
            require(isinstance(detail,dict) and isinstance(detail.get('left'),dict) and isinstance(detail.get('right'),dict),'IDENTITY_TARGET_REQUIRED')
            key='pair-'+digest(sorted([detail['left']['id'],detail['right']['id']]))[:40]
        else:key=_identifier(request.get('id'))
        version=request.get('expectedVersion',0);require(type(version) is int and 0<=version<100,'IDENTITY_VERSION')
        chain=history(records,kind,key);previous=next((r for r in chain if r['version']==version),None)
        require(version==0 or previous is not None,'IDENTITY_VERSION_CONFLICT')
        if previous:require(request.get('binding')==reference(previous),'IDENTITY_BINDING_STALE')
        payload=compile_record(records,kind,key,detail,previous)
        return public(records.put(payload,expected_version=version,request_id=request.get('requestId')))
    require(op in ('identity_get','identity_history'),'IDENTITY_OPERATION')
    records.db.execute('BEGIN');kind=request.get('kind');require(kind in ('entity','link'),'IDENTITY_KIND')
    version=request.get('version')
    if op=='identity_get' and version is not None:
        require(type(version) is int and version>0,'IDENTITY_REFERENCE_VERSION')
        row=records.db.execute('SELECT recorded_at FROM record_versions WHERE scope=? AND record_id=? AND version=?',(records.memory.scope,rid(records.memory.scope,kind,request.get('id')),version)).fetchone()
        require(row is not None and (known is None or instant(row[0])<=instant(known)),'IDENTITY_VERSION_NOT_AT_CUT')
        known=row[0]
    chain=history(records,kind,request.get('id'),known);require(chain,'IDENTITY_NOT_FOUND')
    if op=='identity_history':return [public(r) for r in chain]
    version=request.get('version');record=next((r for r in chain if r['version']==version),None) if version is not None else chain[-1]
    require(record is not None,'IDENTITY_VERSION_NOT_AT_CUT');return public(record)
