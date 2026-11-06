"""Bounded read-only native Janus adapter for a newly restored loopback cluster."""
import json,urllib.request,urllib.parse
from orbita_store import StoreError as RecordError
from orbita_store.config import require
from orbita_store.service_archive import canonical
MAX_BYTES=16*1024**2
_json=lambda v:canonical(v).decode()

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

SCHEMA="\ndef m=graph.openManagement();\ntry {\n if (createSchema && m.getPropertyKey('orbitaUid')==null) {\n  ['orbitaUid','orbitaGroup','orbitaKind','orbitaKey','orbitaPayload'].each {m.makePropertyKey(it).dataType(String.class).cardinality(org.janusgraph.core.Cardinality.SINGLE).make()};\n  m.makeVertexLabel('orbitaObject').make();\n  def ix=m.buildIndex('orbitaUidIndex',org.apache.tinkerpop.gremlin.structure.Vertex.class).addKey(m.getPropertyKey('orbitaUid')).unique().buildCompositeIndex();m.setConsistency(ix,org.janusgraph.core.schema.ConsistencyModifier.LOCK);\n  m.buildIndex('orbitaGroupIndex',org.apache.tinkerpop.gremlin.structure.Vertex.class).addKey(m.getPropertyKey('orbitaGroup')).buildCompositeIndex();\n  ['orbita_from','orbita_to'].each {def e=m.makeEdgeLabel(it).multiplicity(org.janusgraph.core.Multiplicity.MANY2ONE).make();m.setConsistency(e,org.janusgraph.core.schema.ConsistencyModifier.LOCK)};\n  m.commit();m=graph.openManagement();\n }\n def keys=['orbitaUid','orbitaGroup','orbitaKind','orbitaKey','orbitaPayload'];\n def ok=keys.every {def k=m.getPropertyKey(it);k!=null && k.dataType()==String.class && k.cardinality()==org.janusgraph.core.Cardinality.SINGLE};\n def ui=m.getGraphIndex('orbitaUidIndex');def gi=m.getGraphIndex('orbitaGroupIndex');\n ok=ok && ui!=null && ui.isUnique() && ui.isCompositeIndex() && m.getConsistency(ui)==org.janusgraph.core.schema.ConsistencyModifier.LOCK && gi!=null && gi.isCompositeIndex();\n if(ok)ok=ui.getFieldKeys().collect{it.name()}==['orbitaUid'] && gi.getFieldKeys().collect{it.name()}==['orbitaGroup'] && ui.getIndexStatus(m.getPropertyKey('orbitaUid')).name()=='ENABLED' && gi.getIndexStatus(m.getPropertyKey('orbitaGroup')).name()=='ENABLED';\n ok=ok && m.getVertexLabel('orbitaObject')!=null && ['orbita_from','orbita_to'].every {def e=m.getEdgeLabel(it);e!=null && e.multiplicity()==org.janusgraph.core.Multiplicity.MANY2ONE && m.getConsistency(e)==org.janusgraph.core.schema.ConsistencyModifier.LOCK};\n def cfg=[:];['storage.backend','storage.cql.keyspace','storage.cql.replication-factor','storage.cql.read-consistency-level','storage.cql.write-consistency-level','cache.db-cache','schema.default'].each{cfg[it]=graph.configuration().getProperty(it)?.toString()};\n return groovy.json.JsonOutput.toJson([schema:ok,configuration:cfg]);\n} finally {m.rollback();graph.tx().rollback()}\n"
SCRIPTS={'ids': 'try {return groovy.json.JsonOutput.toJson(g.V().limit(maximum).id().toList());} finally {graph.tx().rollback()}', 'content': 'try {\n def vs=g.V(nativeIds as Object[]).toList();\n if(vs){graph.multiQuery(vs).preFetch();graph.multiQuery(vs).direction(org.apache.tinkerpop.gremlin.structure.Direction.BOTH).edges();}\n def props={e->e.keys().sort().collectEntries{k->[k,e.values(k).toList()]}};\n def edge={e->[id:e.id().toString(),label:e.label(),from:e.outVertex().id(),to:e.inVertex().id(),properties:props(e)]};\n return groovy.json.JsonOutput.toJson(vs.collect{v->[id:v.id(),label:v.label(),properties:props(v),outgoing:g.V(v).outE().toList().collect{e->edge(e)},incoming:g.V(v).inE().toList().collect{e->edge(e)}]});\n} finally {graph.tx().rollback()}\n'}

class Janus:
    def __init__(self,admission):
        self.endpoints=admission["endpoints"]
        require(len(self.endpoints)==2 and len(set(self.endpoints))==2,"GRAPH_TWO_RESTORED_READERS")
        for endpoint in self.endpoints:
            u=urllib.parse.urlsplit(endpoint)
            require(u.scheme=="http" and u.hostname=="127.0.0.1" and isinstance(u.port,int) and u.port not in (18184,18185) and u.path=="/gremlin" and not u.query and not u.fragment and not u.username and not u.password and endpoint==f'http://127.0.0.1:{u.port}/gremlin',"GRAPH_NEW_LOOPBACK_READERS_ONLY")
        self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())

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
        require(create is False,"GRAPH_SCHEMA_READ_ONLY")
        result=[]
        for i,url in enumerate(self.endpoints):
            r=self.request(url,SCHEMA,{'createSchema':create and i==0})
            require(r.get('schema') is True,'G1_REMOTE_SCHEMA_NOT_QUALIFIED')
            cfg=r['configuration'];require(cfg['storage.backend']=='cql' and cfg['storage.cql.read-consistency-level']=='QUORUM' and cfg['storage.cql.write-consistency-level']=='QUORUM' and cfg['storage.cql.replication-factor']=='3' and cfg['cache.db-cache']=='false' and cfg['schema.default']=='none','G1_REMOTE_CONFIGURATION_NOT_QUALIFIED')
            result.append(cfg)
        require(result[0]==result[1],'G1_REMOTE_READERS_DIFFERENT_BACKEND');return result[0]
