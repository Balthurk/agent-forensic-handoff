"""Bounded, conservative generation inventory. Never authorizes or runs purge."""
import contextlib,datetime,json,re,time
from collections import Counter,defaultdict
from psycopg import sql
from orbita_store.objects import ObjectStore
from .common_backend import connect
from .graph_publication import require,plan,POLICY
from .graph_snapshot import source_snapshot,import_snapshot
from .graph_mirror import binding
from .knowledge_records import RecordError,_json

MAX_GENERATIONS=1000
MAX_REFERENCES=10000
MAX_FILES=4000
MAX_RESULT_BYTES=1024*1024
MAX_SECONDS=15

def envelope():
    return dict(schema='orbita-graph-inventory-1',observedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
        dryRun=True,purgeAuthorized=False,mutationPerformed=False,readbackVerified=False,
        entries=[],excludedGenerations=0,pendingWithoutGeneration=0,
        unattributed=dict(retainedGroups=0,retainedFiles=0,reason='Unknown or incomplete attribution is retained; no identities or bodies disclosed'),
        activeLeases=0,storesPresent=dict(local=False,mirror=False,ledger=False),
        simulation=dict(removeGenerations=[],reason='Every known generation is referenced by durable N04 history; unknown material is retained conservatively. This observation grants no later deletion authority.'),
        limits=dict(generations=MAX_GENERATIONS,references=MAX_REFERENCES,files=MAX_FILES,resultBytes=MAX_RESULT_BYTES,seconds=MAX_SECONDS),
        policy=POLICY)

def empty_inventory(request):
    require(request.get('backend') in (None,'postgresql','postgresql-verified'),'G1_REMOTE_BACKEND_NOT_QUALIFIED')
    return envelope()

def inventory(records,request):
    result=empty_inventory(request);root=records.path.parent/'graph-publications'
    deadline=time.monotonic()+MAX_SECONDS
    def budget():require(time.monotonic()<=deadline,'G1_INVENTORY_TIME_BUDGET')
    def bounded(rows,maximum):
        budget();require(len(rows)<=maximum,'G1_INVENTORY_METADATA_BUDGET');return rows
    def query(db,statement,args=(),maximum=MAX_REFERENCES):
        budget();return bounded(db.execute(statement+' LIMIT ?',(*args,maximum+1)).fetchall(),maximum)
    with contextlib.ExitStack() as stack:
        objects=stack.enter_context(ObjectStore(records.db.config,records.db.session.binding,read_only=True))
        stores={}
        for key,name,family in [('local','graph.pgstore','graph'),('mirror','mirror.pgstore','graph_mirror'),('ledger','mirror-ledger.pgstore','graph_ledger')]:
            path=root/name
            if objects.exists(path.key):
                stores[key]=stack.enter_context(contextlib.closing(connect(path,family=family,read_only=True)))
                stores[key].row_factory=None;result['storesPresent'][key]=True
        with source_snapshot(records) as snapshot:
            # Every participating session was admitted before the exported
            # snapshot. The namespace metadata shares that same snapshot too.
            for db in stores.values():import_snapshot(db,snapshot)
            objects.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
            objects.raw.execute(sql.SQL('SET TRANSACTION SNAPSHOT {}').format(sql.Literal(snapshot)))
            observed=records.db.raw.execute('SELECT transaction_timestamp(),EXTRACT(EPOCH FROM transaction_timestamp())').fetchone()
            result['observedAt']=observed[0].isoformat();epoch=float(observed[1])
            refs=defaultdict(Counter);physical=defaultdict(Counter);states=defaultdict(set);anchors={}
            outboxes=query(records.db,'SELECT outbox_id FROM g1_projection_outbox WHERE scope=? ORDER BY outbox_id',(request['scope'],),MAX_GENERATIONS)
            events=query(records.db,'SELECT e.generation_id,e.state,o.outbox_id FROM g1_projection_events e JOIN g1_projection_outbox o ON o.outbox_id=e.outbox_id WHERE o.scope=? ORDER BY o.outbox_id,e.sequence',(request['scope'],))
            for generation,state,oid in events:
                if generation:
                    refs[generation]['n04Events']+=1
                    if state=='selected':refs[generation]['n04SelectedEvents']+=1
                    states[generation].add(state)
            for row in outboxes:
                entry=records.g1_outbox_entry(row[0]);generation=entry['generation_id']
                if generation:anchors[generation]=entry
                else:result['pendingWithoutGeneration']+=1
            require(len(anchors)<=MAX_GENERATIONS,'G1_INVENTORY_GENERATION_BUDGET')
            if 'local' in stores:
                db=stores['local']
                for gen,count in query(db,'SELECT generation,COUNT(*) FROM objects GROUP BY generation',maximum=MAX_GENERATIONS):physical[gen]['localObjects']=count
                for (gen,) in query(db,'SELECT generation FROM markers',maximum=MAX_GENERATIONS):refs[gen]['localMarkers']+=1
                for (gen,) in query(db,'SELECT generation FROM selectors',maximum=MAX_GENERATIONS):refs[gen]['localSelectors']+=1
            prefix=root.key+'/'
            files=bounded(objects.raw.execute("SELECT path FROM orbita_common.entries WHERE starts_with(path,%s) AND strpos(substring(path from %s),'/')=0 ORDER BY path LIMIT %s",(prefix,len(prefix)+1,MAX_FILES+1)).fetchall(),MAX_FILES)
            for (path,) in files:
                name=path[len(prefix):]
                match=re.fullmatch(r'(g1(?:pg|local)-[0-9a-f]{64})\.(plan|receipt)\.json',name)
                if match:refs[match[1]]['localPlans' if match[2]=='plan' else 'localReceipts']+=1
                elif name not in ('graph.pgstore','mirror.pgstore','mirror-ledger.pgstore'):result['unattributed']['retainedFiles']+=1
            admission=binding(records);namespace=admission['namespace']+':'
            unknown_groups=0
            if 'mirror' in stores:
                for group,count in query(stores['mirror'],'SELECT group_id,COUNT(*) FROM objects GROUP BY group_id',maximum=MAX_GENERATIONS):
                    if group.startswith(namespace) and re.fullmatch(r'g1(?:pg|local)-[0-9a-f]{64}',group[len(namespace):]):physical[group[len(namespace):]]['mirrorObjects']=count
                    else:unknown_groups+=1
            if 'ledger' in stores:
                db=stores['ledger']
                for gen,count in query(db,'SELECT generation,COUNT(*) FROM receipts GROUP BY generation',maximum=MAX_GENERATIONS):refs[gen]['mirrorReceipts']=count
                for (gen,) in query(db,'SELECT generation FROM selectors WHERE config=? AND scope=?',(admission['identity'],request['scope']),MAX_GENERATIONS):refs[gen]['mirrorSelectors']+=1
                claims=query(db,'SELECT fence,expires FROM claims WHERE config=? AND scope=?',(admission['identity'],request['scope']),MAX_GENERATIONS)
                result['activeLeases']=sum(expires>epoch for fence,expires in claims)
            active=result['activeLeases']>0
            all_generations=set(refs)|set(physical)|set(anchors)
            require(len(all_generations)<=MAX_GENERATIONS,'G1_INVENTORY_GENERATION_BUDGET')
            result['unattributed']['retainedGroups']=len(all_generations-set(anchors))+unknown_groups
            fields=('n04Events','n04SelectedEvents','localPlans','localReceipts','localMarkers','localSelectors','mirrorReceipts','mirrorSelectors')
            for generation,entry in sorted(anchors.items()):
                budget()
                try:p=plan(records,entry['outbox_id'])
                except RecordError as error:
                    if error.code in ('SOURCE_SCOPE_MISMATCH','SOURCE_UNAVAILABLE','SOURCE_REVISION_MISMATCH'):
                        result['excludedGenerations']+=1;continue
                    raise
                require(p['generation']==generation,'G1_INVENTORY_REFERENCE_MISMATCH')
                reference={key:refs[generation][key] for key in fields}
                stored={key:physical[generation][key] for key in ('localObjects','mirrorObjects')}
                local=('selected' if reference['localSelectors'] else 'historical_referenced' if reference['n04SelectedEvents'] or reference['localReceipts'] else 'aborted' if entry['state']=='failed' else 'in_progress')
                mirror=('selected' if reference['mirrorSelectors'] else 'historical_referenced' if reference['mirrorReceipts'] else 'in_progress' if active else 'aborted' if stored['mirrorObjects'] else 'absent')
                reasons=[key for key,value in reference.items() if value]
                if active:reasons.append('active_scope_lease_generation_not_attributed')
                if mirror in ('aborted','absent') or local=='aborted':reasons.append('incomplete_publication_requires_retention')
                require(bool(reasons),'G1_INVENTORY_UNATTRIBUTED_REFERENCE')
                result['entries'].append(dict(generation=generation,states=dict(local=local,mirror=mirror),
                    references=reference,physical=stored,activeLease=active,retained=True,retentionReasons=reasons,readbackVerified=False))
            # Revocation fences remain non-MVCC. An invalidated snapshot must
            # never be returned as a misleading empty inventory.
            require(records.db.raw.execute('SELECT orbita_common.workspace_id()::text').fetchone()[0]==records.db.session.binding.workspace_id,'G1_INVENTORY_AUTHORITY_CHANGED')
            budget();require(len(_json(result).encode('utf8'))<=MAX_RESULT_BYTES,'G1_INVENTORY_RESULT_BUDGET')
    return result
