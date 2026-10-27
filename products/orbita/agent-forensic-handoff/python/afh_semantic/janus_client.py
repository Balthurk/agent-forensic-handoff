"""Fixed-script, bounded HTTP adapter for an explicitly admitted local Janus mirror."""
import json,os,re,sys,urllib.request,urllib.parse
from pathlib import Path
from .knowledge_records import RecordError,_json
from .graph_publication import digest,require,MAX_BYTES
from .postgres_backend import plain,normalized

def binding(records):
    semantic=plain(records.path.parent)
    if semantic.name!='semantic':
        require(bool(os.environ.get('AFH_G1_JANUS_CONFIG')),'G1_REMOTE_BACKEND_NOT_QUALIFIED')
        raise RecordError('G1_REMOTE_ROOT_INVALID')
    root=semantic.parent;paused=root.parent/('.'+root.name+'.orbita-restore.json')
    if paused.exists():
        require(json.loads(plain(paused).read_text()).get('externalAccess') is True,'G1_REMOTE_EXTERNAL_ACCESS_PAUSED')
    require(os.environ.get('AFH_MANAGED')!='1','G1_REMOTE_MANAGED_NOT_ADMITTED')
    name=os.environ.get('AFH_G1_JANUS_CONFIG')
    require(bool(name),'G1_REMOTE_BACKEND_NOT_QUALIFIED')
    try:
        path=plain(name);require(path!=root and root not in path.parents and path.stat().st_size<=65536,'G1_REMOTE_CONFIG_OUTSIDE_DATA_REQUIRED')
        cfg=json.loads(path.read_text(encoding='utf8'))
    except Exception:raise RecordError('G1_REMOTE_CONFIG_UNAVAILABLE') from None
    require(isinstance(cfg,dict) and cfg.get('schema')==1 and isinstance(cfg.get('roots'),dict),'G1_REMOTE_CONFIG_INVALID')
    require(len({normalized(k) for k in cfg['roots']})==len(cfg['roots']),'G1_REMOTE_DUPLICATE_ROOT')
    entry=next((v for k,v in cfg['roots'].items() if normalized(k)==normalized(root)),None)
    require(isinstance(entry,dict) and entry.get('active') is True,'G1_REMOTE_ROOT_NOT_ADMITTED')
    require(isinstance(entry.get('namespace'),str) and re.fullmatch('[a-f0-9]{32}',entry['namespace']),'G1_REMOTE_NAMESPACE_INVALID')
    endpoints=cfg.get('endpoints')
    require(isinstance(endpoints,list) and len(endpoints)==2 and len(set(endpoints))==2,'G1_REMOTE_TWO_READERS_REQUIRED')
    for url in endpoints:
        u=urllib.parse.urlsplit(url)
        require(u.scheme=='http' and u.hostname=='127.0.0.1' and u.port and u.path=='/gremlin' and not u.query and not u.fragment and not u.username and not u.password,'G1_REMOTE_ENDPOINT_INVALID')
        require(url==f'http://127.0.0.1:{u.port}/gremlin','G1_REMOTE_ENDPOINT_INVALID')
    identity={'namespace':entry['namespace'],'endpoints':endpoints}
    return {**identity,'identity':digest(identity),'root':root}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise RecordError('G1_REMOTE_REDIRECT_DENIED')

def untyped(v):
    if isinstance(v,dict) and '@type' in v:
        t=v['@type'];x=v['@value']
        if t=='g:Map':return {untyped(x[i]):untyped(x[i+1]) for i in range(0,len(x),2)}
        return untyped(x)
    if isinstance(v,list):return [untyped(x) for x in v]
    if isinstance(v,dict):return {k:untyped(x) for k,x in v.items()}
    return v

SCHEMA=r'''
def m=graph.openManagement();
try {
 if (createSchema && m.getPropertyKey('orbitaUid')==null) {
  ['orbitaUid','orbitaGroup','orbitaKind','orbitaKey','orbitaPayload'].each {m.makePropertyKey(it).dataType(String.class).cardinality(org.janusgraph.core.Cardinality.SINGLE).make()};
  m.makeVertexLabel('orbitaObject').make();
  def ix=m.buildIndex('orbitaUidIndex',org.apache.tinkerpop.gremlin.structure.Vertex.class).addKey(m.getPropertyKey('orbitaUid')).unique().buildCompositeIndex();m.setConsistency(ix,org.janusgraph.core.schema.ConsistencyModifier.LOCK);
  m.buildIndex('orbitaGroupIndex',org.apache.tinkerpop.gremlin.structure.Vertex.class).addKey(m.getPropertyKey('orbitaGroup')).buildCompositeIndex();
  ['orbita_from','orbita_to'].each {def e=m.makeEdgeLabel(it).multiplicity(org.janusgraph.core.Multiplicity.MANY2ONE).make();m.setConsistency(e,org.janusgraph.core.schema.ConsistencyModifier.LOCK)};
  m.commit();m=graph.openManagement();
 }
 def keys=['orbitaUid','orbitaGroup','orbitaKind','orbitaKey','orbitaPayload'];
 def ok=keys.every {def k=m.getPropertyKey(it);k!=null && k.dataType()==String.class && k.cardinality()==org.janusgraph.core.Cardinality.SINGLE};
 def ui=m.getGraphIndex('orbitaUidIndex');def gi=m.getGraphIndex('orbitaGroupIndex');
 ok=ok && ui!=null && ui.isUnique() && ui.isCompositeIndex() && m.getConsistency(ui)==org.janusgraph.core.schema.ConsistencyModifier.LOCK && gi!=null && gi.isCompositeIndex();
 if(ok)ok=ui.getFieldKeys().collect{it.name()}==['orbitaUid'] && gi.getFieldKeys().collect{it.name()}==['orbitaGroup'] && ui.getIndexStatus(m.getPropertyKey('orbitaUid')).name()=='ENABLED' && gi.getIndexStatus(m.getPropertyKey('orbitaGroup')).name()=='ENABLED';
 ok=ok && m.getVertexLabel('orbitaObject')!=null && ['orbita_from','orbita_to'].every {def e=m.getEdgeLabel(it);e!=null && e.multiplicity()==org.janusgraph.core.Multiplicity.MANY2ONE && m.getConsistency(e)==org.janusgraph.core.schema.ConsistencyModifier.LOCK};
 def cfg=[:];['storage.backend','storage.cql.keyspace','storage.cql.replication-factor','storage.cql.read-consistency-level','storage.cql.write-consistency-level','cache.db-cache','schema.default'].each{cfg[it]=graph.configuration().getProperty(it)?.toString()};
 return groovy.json.JsonOutput.toJson([schema:ok,configuration:cfg]);
} finally {m.rollback();graph.tx().rollback()}
'''
UPSERT=r'''
try {
 def known=g.V().has('orbitaUid',within(rows.collect{it.uid})).toList();
 if(known)graph.multiQuery(known).preFetch();
 def byUid=[:];for(v in known){def uid=v.value('orbitaUid');if(byUid.containsKey(uid))throw new IllegalStateException('DUPLICATE_UID');byUid[uid]=v;}
 for (row in rows) {
  def v=byUid[row.uid];if(v==null){v=graph.addVertex(org.apache.tinkerpop.gremlin.structure.T.label,'orbitaObject','orbitaUid',row.uid,'orbitaGroup',group,'orbitaKind',row.kind,'orbitaKey',row.key,'orbitaPayload',row.payload);byUid[row.uid]=v;}
  if(v.label()!='orbitaObject' || v.value('orbitaGroup')!=group || v.value('orbitaKind')!=row.kind || v.value('orbitaKey')!=row.key || v.value('orbitaPayload')!=row.payload)throw new IllegalStateException('IMMUTABLE_OBJECT_MISMATCH');
 }
 graph.tx().commit();return groovy.json.JsonOutput.toJson([written:rows.size()]);
} finally {graph.tx().rollback()}
'''
LINKS=r'''
try {
 def uids=rows.collectMany{[it.uid,it.orbita_from,it.orbita_to]}.unique();
 def known=g.V().has('orbitaUid',within(uids)).toList();
 if(known){graph.multiQuery(known).preFetch();graph.multiQuery(known).direction(org.apache.tinkerpop.gremlin.structure.Direction.OUT).edges();}
 def byUid=[:];for(v in known){def uid=v.value('orbitaUid');if(byUid.containsKey(uid))throw new IllegalStateException('DUPLICATE_UID');byUid[uid]=v;}
 for(row in rows) {
  def v=byUid[row.uid];if(v==null)throw new IllegalStateException('LINK_OBJECT_MISSING');
  for(label in ['orbita_from','orbita_to']) {
   def targetUid=row[label];def old=g.V(v).out(label).values('orbitaUid').toList();
   if(old.size()>1 || (old && old[0]!=targetUid))throw new IllegalStateException('IMMUTABLE_LINK_MISMATCH');
   if(!old){def target=byUid[targetUid];if(target==null)throw new IllegalStateException('LINK_TARGET_MISSING');v.addEdge(label,target);}
  }
 }
 graph.tx().commit();return groovy.json.JsonOutput.toJson([linked:rows.size()]);
} finally {graph.tx().rollback()}
'''
READ=r'''
try {
 def vs=g.V().has('orbitaGroup',group).limit(maximum).toList();
 if(vs){graph.multiQuery(vs).preFetch();graph.multiQuery(vs).direction(org.apache.tinkerpop.gremlin.structure.Direction.BOTH).edges();}
 def rows=vs.collect { v ->
  [label:v.label(),uid:v.value('orbitaUid'),kind:v.value('orbitaKind'),key:v.value('orbitaKey'),payload:v.value('orbitaPayload'),properties:v.keys().sort(),links:g.V(v).outE().toList().collect{e->[label:e.label(),target:e.inVertex().value('orbitaUid')]}.sort{a,b->(a.label+a.target)<=>(b.label+b.target)},incoming:g.V(v).inE().toList().collect{e->[label:e.label(),source:e.outVertex().value('orbitaUid')]}.sort{a,b->(a.label+a.source)<=>(b.label+b.source)}]
 };
 return groovy.json.JsonOutput.toJson(rows.sort{a,b->a.uid<=>b.uid});
} finally {graph.tx().rollback()}
'''

MEMBERS=r'''
try {
 return groovy.json.JsonOutput.toJson(g.V().has('orbitaGroup',group).limit(maximum).project('uid','id').by(values('orbitaUid')).by(id()).toList().sort{a,b->a.uid<=>b.uid});
} finally {graph.tx().rollback()}
'''
READ_BATCH=READ.replace("g.V().has('orbitaGroup',group).limit(maximum).toList()", "g.V(nativeIds as Object[]).has('orbitaGroup',group).toList()")

class Janus:
    def __init__(self,admission):self.admission=admission;self.endpoints=admission['endpoints'];self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect());self.sequence=0
    def progress(self,stage,completed):
        if os.environ.get('AFH_G1_PROGRESS')=='1':
            self.sequence+=1
            print('ORBITA_G1_PROGRESS '+json.dumps(dict(schema=1,sequence=self.sequence,stage=stage,completed=completed)),file=sys.stderr,flush=True)
    def request(self,endpoint,script,bindings):
        body=_json({'gremlin':script,'bindings':bindings,'language':'gremlin-groovy'}).encode()
        require(len(body)<=MAX_BYTES*2,'G1_REMOTE_REQUEST_BUDGET')
        try:
            req=urllib.request.Request(endpoint,data=body,headers={'Content-Type':'application/json','Accept':'application/json'})
            with self.opener.open(req,timeout=18) as r:raw=r.read(MAX_BYTES*3+1)
            require(len(raw)<=MAX_BYTES*3,'G1_REMOTE_RESPONSE_BUDGET');data=untyped(json.loads(raw))
            require(data['status']['code']==200,'G1_REMOTE_SERVICE_ERROR');items=data['result']['data']
            require(isinstance(items,list) and len(items)==1 and isinstance(items[0],str),'G1_REMOTE_RESPONSE_INVALID')
            return json.loads(items[0])
        except RecordError:raise
        except Exception:raise RecordError('G1_REMOTE_UNAVAILABLE_OR_INVALID_RESPONSE') from None
    def schema(self,create=False):
        result=[]
        for i,url in enumerate(self.endpoints):
            r=self.request(url,SCHEMA,{'createSchema':create and i==0})
            require(r.get('schema') is True,'G1_REMOTE_SCHEMA_NOT_QUALIFIED')
            cfg=r['configuration'];require(cfg['storage.backend']=='cql' and cfg['storage.cql.read-consistency-level']=='QUORUM' and cfg['storage.cql.write-consistency-level']=='QUORUM' and cfg['storage.cql.replication-factor']=='3' and cfg['cache.db-cache']=='false' and cfg['schema.default']=='none','G1_REMOTE_CONFIGURATION_NOT_QUALIFIED')
            result.append(cfg)
        require(result[0]==result[1],'G1_REMOTE_READERS_DIFFERENT_BACKEND');return result[0]
    def group(self,p):return self.admission['namespace']+':'+p['generation']
    def objects(self,p,marker=False):
        rows=[]
        vals=p['vertices']+p['edges']
        for v in vals:rows.append(dict(kind=v['kind'],key=v['key'],payload=_json(v)))
        if marker:rows.append(dict(kind='marker',key='marker',payload=_json({'planHash':digest(p),'readbackHash':digest(sorted((v['kind'],v['key'],_json(v)) for v in vals))})))
        for row in rows:row['uid']=digest([self.group(p),row['kind'],row['key']])
        return rows
    def expected(self,p,marker=False):
        rows=self.objects(p,marker);ids={r['key']:r['uid'] for r in rows};edges={e['key']:e for e in p['edges']}
        for r in rows:
            r.update(label='orbitaObject',properties=['orbitaGroup','orbitaKey','orbitaKind','orbitaPayload','orbitaUid'],links=[],incoming=[])
            if r['key'] in edges:
                e=edges[r['key']];r['links']=[{'label':'orbita_from','target':ids[e['from']]},{'label':'orbita_to','target':ids[e['to']]}]
        byid={r['uid']:r for r in rows}
        for r in rows:
            for e in r['links']:byid[e['target']]['incoming'].append({'label':e['label'],'source':r['uid']})
        for r in rows:r['incoming'].sort(key=lambda e:e['label']+e['source'])
        return sorted(rows,key=lambda r:r['uid'])
    def write(self,p):
        rows=self.objects(p);group=self.group(p)
        for i in range(0,len(rows),50):
            self.request(self.endpoints[0],UPSERT,{'group':group,'rows':rows[i:i+50]});self.progress('objects',min(i+50,len(rows)))
        ids={r['key']:r['uid'] for r in rows};links=[dict(uid=ids[e['key']],orbita_from=ids[e['from']],orbita_to=ids[e['to']]) for e in p['edges']]
        for i in range(0,len(links),50):
            self.request(self.endpoints[0],LINKS,{'rows':links[i:i+50]});self.progress('links',min(i+50,len(links)))
    def verify(self,p,marker=True):
        expected=self.expected(p,marker);observed=[]
        for url in self.endpoints:
            ids=[r['uid'] for r in expected];group=self.group(p);bounds={'group':group,'maximum':len(expected)+2}
            before=self.request(url,MEMBERS,bounds);normalized=[row['uid'] for row in before]
            # An earlier interrupted attempt may have written the one exact marker UID.
            if not marker:
                marker_uid=self.objects(p,True)[-1]['uid']
                if marker_uid in normalized:normalized.remove(marker_uid)
            require(normalized==ids,'G1_REMOTE_READBACK_MISMATCH')
            native_ids={row['uid']:row['id'] for row in before}
            rows=[]
            for start in range(0,len(ids),150):
                batch=self.request(url,READ_BATCH,{'group':group,'nativeIds':[native_ids[uid] for uid in ids[start:start+150]]})
                require(batch==expected[start:start+150],'G1_REMOTE_READBACK_MISMATCH')
                rows.extend(batch);self.progress('readback',len(rows))
            require(self.request(url,MEMBERS,bounds)==before,'G1_REMOTE_MEMBERSHIP_CHANGED')
            require(rows==expected,'G1_REMOTE_READBACK_MISMATCH');observed.append(digest(rows));self.progress('readback',len(observed))
        return observed
    def marker(self,p):
        rows=[r for r in self.objects(p,True) if r['kind']=='marker'];self.request(self.endpoints[0],UPSERT,{'group':self.group(p),'rows':rows})
