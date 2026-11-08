"""G1 generations in the common PostgreSQL store; N04 remains authority.

Independently implemented after read-only review of Noetis' generation contract.
Historical plan/receipt hashes retain their original versioned contract.
"""
import contextlib,hashlib,json,os
from .graph_snapshot import source_snapshot,import_snapshot
from .common_backend import connect
from .knowledge_records import RecordError,_json,_identifier
from .relational_memory import instant

MAX_MEMBERS=1000
MAX_BYTES=16*1024*1024
LEGACY_POLICY={'backend':'sqlite-local-g1','remoteBackendQualified':False,'executionAuthority':False,
        'humanAcceptance':False,'truth':'not_established','validity':'not_established',
        'causality':'not_established','coverage':'Exact explicit semantic acts at one source cut; not all information'}
POLICY={**LEGACY_POLICY,'backend':'postgres-common-g1'}
def require(ok,code):
    if not ok:raise RecordError(code)
def digest(value):return hashlib.sha256(_json(value).encode('utf8')).hexdigest()
def checkpoint(name):
    if os.environ.get('AFH_CRASH_AT')==name:os._exit(86)
def latest(records,scope,cut=None):
    row=records.db.execute('SELECT o.outbox_id FROM g1_projection_outbox o JOIN record_versions r ON r.record_id=o.record_id AND r.version=o.record_version WHERE o.scope=?'+(' AND o.source_cut=?' if cut is not None else '')+' ORDER BY r.rowid DESC LIMIT 1',(scope,cut) if cut is not None else (scope,)).fetchone()
    return records.g1_outbox_entry(row[0]) if row else None

def plan(records,oid):
    cache=getattr(records.memory,'_binding_cache',None)
    if cache is not None:cache.clear()
    anchor=records.g1_outbox_entry(oid);members=records.g1_generation_members(oid,limit=MAX_MEMBERS)
    vertices=[];edges=[];missing=[];bindings=[];clauses=set()
    for m in members:
        r=records.get(m['record_id'],m['scope'],version=m['record_version']);p=r['payload'];u=p['semantic_unit']
        require(digest(p)==m['payload_sha256'] and digest(u['manifest'])==m['manifest_sha256'],'G1_N04_BINDING_MISMATCH')
        bindings.append({'outboxId':m['outbox_id'],'recordId':r['id'],'version':r['version'],'payloadHash':digest(p)})
        act='act:'+u['act_id']+':'+str(r['version']);vertices.append({'kind':'act','key':act,'value':r})
        for c in u['clauses']:
            key='clause:'+c['clause_version_id'];require(key not in clauses,'G1_DUPLICATE_CLAUSE');clauses.add(key)
            vertices.append({'kind':'clause','key':key,'value':{'recordId':r['id'],'version':r['version'],'clause':c}})
            edges.append({'kind':'contains','from':act,'to':key,'value':{'manifestHash':m['manifest_sha256']}})
    for v in vertices:
        if v['kind']!='clause':continue
        for rel in v['value']['clause'].get('relations',[]):
            target='clause:'+rel['target_clause_version_id'];edge={'kind':'relation','from':v['key'],'to':target,'value':rel}
            if target not in clauses:missing.append({'clauseVersionId':v['value']['clause']['clause_version_id'],'targetClauseVersionId':rel['target_clause_version_id'],'relation':rel,'reason':'exact_target_outside_generation'})
            else:edges.append(edge)
    for e in edges:e['key']='edge:'+digest(e)
    legacy=(anchor.get('generation_id') or '').startswith('g1local-')
    body={'schema':'orbita-g1-local-plan-1' if legacy else 'orbita-g1-pg-plan-1','anchor':oid,'scope':anchor['scope'],'sourceCut':anchor['source_cut'],
          'authorizationSnapshot':anchor['authorization_snapshot'],'members':bindings,
          'vertices':sorted(vertices,key=lambda x:x['key']),'edges':sorted(edges,key=lambda x:x['key']),
          'missingTargets':missing,'policy':LEGACY_POLICY if legacy else POLICY}
    require(len(_json(body).encode('utf8'))<=MAX_BYTES,'G1_PLAN_BYTE_BUDGET')
    return {**body,'generation':('g1local-' if legacy else 'g1pg-')+digest(body)}

class Projection:
    def __init__(self,records,*,write=False):
        self.root=records.path.parent/'graph-publications';self.path=self.root/'graph.pgstore';self.write=write
        if write:self.root.mkdir(parents=True,exist_ok=True)
        require(write or self.path.is_file(),'G1_PROJECTION_MISSING')
        self.db=connect(self.path,family='graph',read_only=not write);self.db.row_factory=None
        if write:self.db.executescript('''CREATE TABLE IF NOT EXISTS objects(generation TEXT,kind TEXT,key TEXT,payload TEXT,PRIMARY KEY(generation,kind,key));
        CREATE TABLE IF NOT EXISTS markers(generation TEXT PRIMARY KEY,plan_hash TEXT,readback_hash TEXT);
        CREATE TABLE IF NOT EXISTS selectors(scope TEXT,source_cut TEXT,generation TEXT,fence INTEGER,PRIMARY KEY(scope,source_cut));''')
    def close(self):self.db.close()
    def immutable(self,name,value):
        path=self.root/name;raw=_json(value).encode('utf8')
        if path.exists():require(path.read_bytes()==raw,'G1_IMMUTABLE_FILE_MISMATCH')
        else:
            # CommonPath publishes immutable bytes durably on successful close.
            # All crash checkpoints occur after this PostgreSQL commit.
            with path.open('xb') as f:f.write(raw)
        return hashlib.sha256(raw).hexdigest()
    def stored(self,name,expected):
        path=self.root/name;require(path.is_file(),'G1_RECEIPT_OR_PLAN_MISSING')
        raw=_json(expected).encode('utf8');require(path.stat().st_size==len(raw),'G1_RECEIPT_OR_PLAN_MISMATCH')
        require(path.read_bytes()==raw,'G1_RECEIPT_OR_PLAN_MISMATCH')
        return digest(expected)
    @staticmethod
    def rows(p):return sorted([(v['kind'],v['key'],_json(v)) for v in p['vertices']+p['edges']])
    def upsert(self,p):
        with self.db:
            for kind,key,payload in self.rows(p):
                old=self.db.execute('SELECT payload FROM objects WHERE generation=? AND kind=? AND key=?',(p['generation'],kind,key)).fetchone()
                if old:require(old[0]==payload,'G1_IMMUTABLE_OBJECT_MISMATCH')
                else:self.db.execute('INSERT INTO objects VALUES(?,?,?,?)',(p['generation'],kind,key,payload))
    def verify_rows(self,p):
        wanted=self.rows(p)
        metadata=self.db.execute('SELECT kind,key,length(CAST(payload AS BLOB)) FROM objects WHERE generation=? ORDER BY kind,key LIMIT ?',(p['generation'],len(wanted)+1)).fetchall()
        require(metadata==[(kind,key,len(payload.encode('utf8'))) for kind,key,payload in wanted],'G1_READBACK_MISMATCH')
        actual=self.db.execute('SELECT kind,key,payload FROM objects WHERE generation=? ORDER BY kind,key',(p['generation'],)).fetchall()
        require(actual==wanted,'G1_READBACK_MISMATCH');return digest(actual)
    def marker(self,p,hash_):
        old=self.db.execute('SELECT plan_hash,readback_hash FROM markers WHERE generation=?',(p['generation'],)).fetchone();expected=(digest(p),hash_)
        if old:require(old==expected,'G1_MARKER_MISMATCH')
        else:
            with self.db:self.db.execute('INSERT INTO markers VALUES(?,?,?)',(p['generation'],*expected))
    def verify(self,p):
        h=self.verify_rows(p);row=self.db.execute('SELECT plan_hash,readback_hash FROM markers WHERE generation=?',(p['generation'],)).fetchone()
        require(row==(digest(p),h),'G1_MARKER_MISMATCH');self.stored(p['generation']+'.plan.json',p);return h
    def select(self,p,fence):
        with self.db:
            old=self.db.execute('SELECT generation,fence FROM selectors WHERE scope=? AND source_cut=?',(p['scope'],p['sourceCut'])).fetchone()
            require(old is None or old[1]<fence or old==(p['generation'],fence),'G1_SELECTOR_STALE_FENCE')
            self.db.execute('INSERT INTO selectors VALUES(?,?,?,?) ON CONFLICT(scope,source_cut) DO UPDATE SET generation=excluded.generation,fence=excluded.fence',(p['scope'],p['sourceCut'],p['generation'],fence))
    def verify_selector(self,p,fence):
        row=self.db.execute('SELECT generation,fence FROM selectors WHERE scope=? AND source_cut=?',(p['scope'],p['sourceCut'])).fetchone()
        require(row==(p['generation'],fence),'G1_SELECTOR_MISMATCH')

def receipt(p,entry,readback):
    return {'schema':'orbita-g1-local-receipt-1' if p['generation'].startswith('g1local-') else 'orbita-g1-pg-receipt-1','generation':p['generation'],'outboxId':p['anchor'],
            'scope':p['scope'],'sourceCut':p['sourceCut'],'fence':entry['fence_token'],
            'planHash':digest(p),'readbackHash':readback,'members':len(p['members']),
            'vertices':len(p['vertices']),'edges':len(p['edges']),'policy':p['policy']}

@contextlib.contextmanager
def graph_read_snapshot(records,additional=()):
    # RLS authorization rows must be committed BEFORE the exported snapshot.
    # A reader opened afterwards correctly sees no session authority in it.
    require(not records.db.in_transaction and not hasattr(records,'_g1_snapshot_readers'),'G1_SNAPSHOT_ALREADY_ACTIVE')
    readers=[]
    try:
        if (records.path.parent/'graph-publications'/'graph.pgstore').is_file():
            readers.append(Projection(records));readers.append(Projection(records))
        connections=[g.db for g in readers]+list(additional)
        require(len({c.raw.info.backend_pid for c in connections})==len(connections),'G1_TWO_READERS_REQUIRED')
        require(all(c.config==records.db.config and c.session.binding==records.db.session.binding for c in connections),'G1_SNAPSHOT_BINDING')
        with source_snapshot(records) as snapshot:
            for connection in connections:import_snapshot(connection,snapshot)
            records._g1_snapshot_readers=tuple(readers)
            try:yield
            finally:del records._g1_snapshot_readers
    finally:
        error=None
        for graph in readers:
            try:graph.close()
            except Exception:error=RecordError('G1_READER_CLOSE_UNVERIFIED')
        if error:raise error

def verified_projection(records,p,entry=None,*,current=False):
    borrowed=getattr(records,'_g1_snapshot_readers',None)
    readers=list(borrowed) if borrowed is not None else [];hashes=[];owned=borrowed is None
    try:
        if owned:
            require(not records.db.in_transaction or records.db.raw.execute('SHOW transaction_isolation').fetchone()[0]!='repeatable read','G1_READERS_MUST_PRECEDE_SNAPSHOT')
            readers.append(Projection(records));readers.append(Projection(records))
        require(len(readers)==2,'G1_PROJECTION_MISSING')
        require(len({g.db.raw.info.backend_pid for g in readers})==2,'G1_TWO_READERS_REQUIRED')
        if owned:
            readers[0].db.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
            snapshot=readers[0].db.raw.execute('SELECT pg_export_snapshot()').fetchone()[0];import_snapshot(readers[1].db,snapshot)
        for graph in readers:
            h=graph.verify(p);hashes.append(h)
            if entry is not None:
                r=receipt(p,entry,h);graph.stored(p['generation']+'.receipt.json',r)
                require(digest(r)==entry['detail'].get('receipt_sha256'),'G1_RECEIPT_MISMATCH')
                if current:graph.verify_selector(p,entry['fence_token'])
        require(hashes[0]==hashes[1],'G1_READERS_DISAGREE');return hashes[0]
    finally:
        error=None
        for graph in readers if owned else ():
            try:graph.close()
            except Exception:error=RecordError('G1_READER_CLOSE_UNVERIFIED')
        if error:raise error


def publish(records,oid,scope):
    entry=records.g1_outbox_entry(oid);require(entry['scope']==scope,'G1_SCOPE_MISMATCH');p=plan(records,oid)
    require(entry['generation_id'] in (None,p['generation']),'G1_GENERATION_CONFLICT')
    graph=Projection(records,write=True)
    try:
        if entry['state']=='selected':
            h=verified_projection(records,p);r=receipt(p,entry,h);graph.stored(p['generation']+'.receipt.json',r)
            require(entry['detail'].get('receipt_sha256')==digest(r),'G1_RECEIPT_MISMATCH');return {**r,'state':'selected','replayed':True}
        if entry['state'] in ('planned','failed','upserting','counts_verified','marker_visible'):
            entry=records.begin_g1_projection(oid,p['generation'],expected_state=entry['state'],expected_sequence=entry['sequence'],expected_fence_token=entry['fence_token'])
        graph.immutable(p['generation']+'.plan.json',p)
        if entry['state'] in ('upserting','counts_verified','marker_visible'):
            graph.upsert(p);checkpoint('graph-after-objects');h=graph.verify_rows(p)
            if entry['state']=='upserting':entry=records.advance_g1_projection(oid,expected_state='upserting',state='counts_verified',generation_id=p['generation'],fence_token=entry['fence_token'],detail={'readback':h})
            graph.marker(p,h)
            if entry['state']=='counts_verified':entry=records.advance_g1_projection(oid,expected_state='counts_verified',state='marker_visible',generation_id=p['generation'],fence_token=entry['fence_token'])
            h=verified_projection(records,p)
            if entry['state']=='marker_visible':entry=records.advance_g1_projection(oid,expected_state='marker_visible',state='readback_verified',generation_id=p['generation'],fence_token=entry['fence_token'],detail={'readback':h})
        h=verified_projection(records,p);r=receipt(p,entry,h)
        if entry['state']=='readback_verified':
            graph.immutable(p['generation']+'.receipt.json',r)
            entry=records.advance_g1_projection(oid,expected_state='readback_verified',state='receipt_durable',generation_id=p['generation'],fence_token=entry['fence_token'],detail={'receipt_sha256':digest(r)})
        require(entry['state']=='receipt_durable','G1_NOT_READY');graph.stored(p['generation']+'.receipt.json',r)
        require(entry['detail'].get('receipt_sha256')==digest(r),'G1_RECEIPT_MISMATCH');checkpoint('graph-after-receipt')
        def select():graph.select(p,entry['fence_token']);checkpoint('graph-after-selector')
        records.select_g1_projection(oid,generation_id=p['generation'],fence_token=entry['fence_token'],receipt_sha256=digest(r),select_graph=select)
        return {**r,'state':'selected','replayed':False}
    finally:graph.close()

def selected(records,request):
    scope=request['scope'];mode=request.get('mode','current');require(mode in ('current','system_history'),'G1_MODE_INVALID')
    cut=request.get('sourceCut');require(isinstance(cut,str) and 0<len(cut)<=512,'G1_CUT_REQUIRED')
    generation=request.get('generation');require(isinstance(generation,str) and generation.startswith(('g1local-','g1pg-')),'G1_GENERATION_REQUIRED');_identifier(generation)
    require(not request.get('validAt'),'G1_VALID_AT_UNSUPPORTED')
    if mode=='system_history':
        instant(request.get('knownAt'));entry=records.historical_g1_outbox(scope,generation,request['knownAt'],source_cut=cut)
    else:
        require(request.get('knownAt') is None,'G1_KNOWN_AT_REQUIRES_HISTORY');entry=latest(records,scope)
        require(entry is not None and entry['state']=='selected','CURRENT_PROJECTION_PENDING')
        require(entry['source_cut']==cut,'G1_CURRENT_CUT_MISMATCH')
        require(entry['generation_id']==generation,'G1_CURRENT_GENERATION_MISMATCH')
    p=plan(records,entry['outbox_id']);require(p['generation']==generation and p['sourceCut']==cut,'G1_BINDING_MISMATCH')
    h=verified_projection(records,p,entry,current=mode=='current');r=receipt(p,entry,h)
    at=next(e['recorded_at'] for e in entry['events'] if e['state']=='selected')
    return p,r,at

def dispatch_graph(records,request):
    op=request['op'];scope=request['scope']
    if op=='graph_inventory':
        from .graph_inventory import inventory
        return inventory(records,request)
    if op=='graph_capabilities':
        return {'configured':True,'backend':'postgresql','readers':2,'verified':False,'default':'postgresql','automaticPromotion':False,'humanAcceptance':False}
    if request.get('backend')=='postgresql-verified':
        from .graph_mirror_publication import dispatch_verified
        return dispatch_verified(records,request)
    require(not request.get('backend') or request['backend']=='postgresql','G1_REMOTE_BACKEND_NOT_QUALIFIED')
    if op=='graph_publish':
        return publish(records,request['outboxId'],scope)
    # Hold a single N04 read snapshot while verifying generations and current sources.
    require(not records.db.in_transaction,'G1_SNAPSHOT_ALREADY_ACTIVE')
    with (source_snapshot(records) if op=='graph_status' else graph_read_snapshot(records)):
        if op=='graph_status':
            cuts=records.db.execute('SELECT DISTINCT source_cut FROM g1_projection_outbox WHERE scope=? ORDER BY source_cut LIMIT 101',(scope,)).fetchall();require(len(cuts)<=100,'G1_CUT_BUDGET')
            entries=[];excluded=0;current=latest(records,scope)
            for row in cuts:
                entry=latest(records,scope,row[0])
                try:p=plan(records,entry['outbox_id'])
                except RecordError as e:
                    if e.code in ('SOURCE_SCOPE_MISMATCH','SOURCE_UNAVAILABLE','SOURCE_REVISION_MISMATCH'):excluded+=1;continue
                    raise
                # A status is a ledger observation, never an assertion of verified readback.
                entries.append({'outboxId':entry['outbox_id'],'sourceCut':row[0],'generation':entry['generation_id'],
                                'state':entry['state'],'members':len(p['members']),'vertices':len(p['vertices']),
                                'edges':len(p['edges']),'missingTargets':len(p['missingTargets']),'readbackVerified':False,
                                'currentAnchor':entry['outbox_id']==current['outbox_id'],
                                'selectedAt':next((e['recorded_at'] for e in entry['events'] if e['state']=='selected'),None)})
            return {'entries':entries,'excludedSourceCuts':excluded,'policy':POLICY,'maxMembers':MAX_MEMBERS,'maxPlanBytes':MAX_BYTES}
        require(op in ('graph_query','graph_original'),'UNKNOWN_GRAPH_OPERATION')
        p,r,at=selected(records,request)
        return render(records,request,p,r,at)

def render(records,request,p,r,at,overhead=0):
    scope=request['scope']
    if request['op']=='graph_original':
        act=next((x['value'] for x in p['vertices'] if x['kind']=='act' and x['value']['id']==request.get('recordId')),None);require(act is not None,'G1_MEMBER_NOT_FOUND')
        ref=next((x for x in act['payload']['source_refs'] if x['id']==request.get('sourceId')),None);require(ref is not None,'G1_SOURCE_NOT_IN_MEMBER')
        source=records._source(ref,scope);require(len(_json(source).encode('utf8'))<=2000000,'G1_ORIGINAL_BYTE_BUDGET');return {'source':source,'generation':p['generation'],'policy':POLICY}
    offset=request.get('offset',0);limit=request.get('limit',10);maximum=request.get('maxBytes',100000)
    require(type(offset) is int and 0<=offset<=len(p['members']) and type(limit) is int and 1<=limit<=50 and type(maximum) is int and 4096<=maximum<=200000,'G1_PAGE_BUDGET')
    acts=sorted([x['value'] for x in p['vertices'] if x['kind']=='act'],key=lambda x:x['id']);items=[];omissions=[];position=offset
    result={'generation':p['generation'],'sourceCut':p['sourceCut'],'mode':request.get('mode','current'),'selectedAt':at,'receipt':r,'totalMembers':len(acts),'items':items,'omissions':omissions,'nextOffset':None,'requiresAbstention':True,'policy':POLICY}
    while position<len(acts) and len(items)<limit:
        act=acts[position];cids={'clause:'+c['clause_version_id'] for c in act['payload']['semantic_unit']['clauses']}
        item={'record':act,'relations':[e for e in p['edges'] if e['kind']=='relation' and (e['from'] in cids or e['to'] in cids)],'missingTargets':[m for m in p['missingTargets'] if 'clause:'+m['clauseVersionId'] in cids]}
        items.append(item)
        if len(_json(result).encode('utf8'))+1000+overhead>maximum:
            items.pop()
            if not items:omissions.append({'recordId':act['id'],'reason':'whole_member_exceeds_page_budget'});position+=1
            break
        position+=1
    result['nextOffset']=position if position<len(acts) else None
    require(len(_json(result).encode('utf8'))<=maximum,'G1_PAGE_BYTE_BUDGET');return result
