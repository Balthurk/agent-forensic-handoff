"""Archive-only topology validation; never inspect or connect to old services."""
from pathlib import Path
import ctypes,hashlib,json,re,time
from orbita_store.config import require
from orbita_store.service_archive import canonical
from pg01_graph_runtime import validate_configuration,CASSANDRA_COMPATIBILITY

CASSANDRA='sha256:6a9e8c2efb54aff21c26a5d14362a7ee0e3ab154480879027fa60894522b0141'
JANUS='sha256:75f57aff4b152ca86b4cdaeefb5335154d7fad412cffef75fa44c7504adc96d4'
TABLES=['edgestore','edgestore_lock_','graphindex','graphindex_lock_','janusgraph_ids','system_properties','system_properties_lock_','systemlog','txlog']
CASSANDRA_ENV={'CASSANDRA_CLUSTER_NAME','CASSANDRA_SEEDS','CASSANDRA_ENDPOINT_SNITCH','CASSANDRA_DC','CASSANDRA_RACK','CASSANDRA_NUM_TOKENS','MAX_HEAP_SIZE','HEAP_NEWSIZE','JVM_EXTRA_OPTS'}
JANUS_ENV={'JANUS_PROPS_TEMPLATE','JAVA_OPTIONS','janusgraph.storage.hostname','janusgraph.storage.cql.keyspace','janusgraph.storage.cql.local-datacenter',
           'janusgraph.storage.cql.replication-factor','janusgraph.storage.cql.read-consistency-level','janusgraph.storage.cql.write-consistency-level',
           'janusgraph.cache.db-cache','janusgraph.schema.default','gremlinserver.channelizer','gremlinserver.evaluationTimeout',
           'gremlinserver.graphs.graph','gremlinserver.threadPoolWorker','gremlinserver.gremlinPool'}

def environment(values):
    require(isinstance(values,list) and all(isinstance(v,str) and '=' in v for v in values),'GRAPH_ARCHIVE_ENV_FORMAT')
    pairs=[v.split('=',1) for v in values];require(len({p[0] for p in pairs})==len(pairs),'GRAPH_ARCHIVE_DUPLICATE_ENV')
    return dict(pairs)

def topology(metadata,images,prefix):
    require(re.fullmatch('orbita-graph-restore-[a-f0-9-]{36}',prefix) is not None,'GRAPH_RESTORE_PREFIX')
    source=metadata['sourceServices'];require(len(source)==5,'GRAPH_ARCHIVE_SERVICE_COUNT')
    require([i['Image'] for i in source]==[CASSANDRA]*3+[JANUS]*2,'GRAPH_ARCHIVE_IMAGE_SET')
    require(metadata['format']=='orbita-legacy-cassandra-native-snapshot-custody-2','GRAPH_ARCHIVE_FORMAT')
    runtime=validate_configuration(metadata.get('runtimeConfiguration'),source)
    before=metadata['beforeCatalog'];after=metadata['afterCatalog']
    require(before['logical']==after['logical'] and sorted(before['logical']['tables'])==TABLES,'GRAPH_ARCHIVE_COMPLETE_CELLS')
    require(hashlib.sha256(canonical(before['logical'])).hexdigest()==before['logicalSha256'],'GRAPH_ARCHIVE_LOGICAL_DIGEST')
    require(before['logical']['keyspace']=='orbita_f30' and before['logical']['schemaCql'].count('CREATE TABLE ')==9,'GRAPH_ARCHIVE_KEYSPACE_SCHEMA')
    require(metadata['completeGraph']['status']=='PASS_TWO_COMPLETE_GRAPH_READERS','GRAPH_ARCHIVE_READERS')
    readers=metadata['completeGraph']['readers'];require(len(readers)==2 and readers[0]['logical']==readers[1]['logical'],'GRAPH_ARCHIVE_READERS_DIFFER')
    require(hashlib.sha256(canonical(readers[0]['logical'])).hexdigest()==metadata['completeGraph']['sha256'],'GRAPH_ARCHIVE_GRAPH_DIGEST')
    nodes=[];names=[prefix+'-c'+str(n) for n in range(1,4)]
    for ordinal,value in enumerate(source):
        image=images[value['Image']];require(image['Id']==value['Image'],'GRAPH_LOCAL_IMAGE_IDENTITY')
        require(value['Config']['Entrypoint']==image['Config']['Entrypoint'] and value['Config']['Cmd']==image['Config']['Cmd'],'GRAPH_ARCHIVED_COMMAND_UNREVIEWED')
        env=environment(value['Config']['Env']);base=environment(image['Config']['Env'])
        require(set(base)<=set(env),'GRAPH_IMAGE_ENV_REMOVED')
        delta={k:v for k,v in env.items() if base.get(k)!=v}
        require(set(delta)<=(CASSANDRA_ENV if ordinal<3 else JANUS_ENV),'GRAPH_UNREVIEWED_ENV_OVERRIDE')
        host=value['HostConfig'];require(host['Memory']==1536*1024**2 and host['MemorySwap']==3072*1024**2 and host['NanoCpus']==1500000000,'GRAPH_ARCHIVED_RESOURCE_LIMITS')
        if ordinal<3:
            require(env['MAX_HEAP_SIZE']=='768M' and env['HEAP_NEWSIZE']=='128M' and env['CASSANDRA_DC']=='orbita' and env['CASSANDRA_NUM_TOKENS']=='16','GRAPH_ARCHIVED_CASSANDRA_CONFIG')
            require(env['CASSANDRA_RACK']=='rack'+str(ordinal+1) and env['CASSANDRA_ENDPOINT_SNITCH']=='GossipingPropertyFileSnitch','GRAPH_ARCHIVED_CASSANDRA_TOPOLOGY')
            require(len(value['Mounts'])==1 and value['Mounts'][0]['Type']=='volume' and value['Mounts'][0]['Destination']=='/var/lib/cassandra','GRAPH_ARCHIVED_CASSANDRA_STORAGE')
            require(env.get('JVM_EXTRA_OPTS','') in ('',' '.join(CASSANDRA_COMPATIBILITY)),'GRAPH_ARCHIVED_EXTRA_JVM_OPTIONS_UNREVIEWED')
            env['JVM_EXTRA_OPTS']=' '.join(CASSANDRA_COMPATIBILITY)
            env.update(CASSANDRA_CLUSTER_NAME=prefix,CASSANDRA_SEEDS=names[0]);name=names[ordinal]
        else:
            required={'JAVA_OPTIONS':'-Xms128m -Xmx768m','JANUS_PROPS_TEMPLATE':'cql','janusgraph.storage.cql.keyspace':'orbita_f30',
                      'janusgraph.storage.cql.local-datacenter':'orbita','janusgraph.storage.cql.replication-factor':'3',
                      'janusgraph.storage.cql.read-consistency-level':'QUORUM','janusgraph.storage.cql.write-consistency-level':'QUORUM',
                      'janusgraph.cache.db-cache':'false','janusgraph.schema.default':'none','gremlinserver.evaluationTimeout':'15000',
                      'gremlinserver.threadPoolWorker':'1','gremlinserver.gremlinPool':'8','gremlinserver.graphs.graph':'/etc/opt/janusgraph/janusgraph.properties'}
            require(all(env.get(k)==v for k,v in required.items()) and not value['Mounts'],'GRAPH_ARCHIVED_JANUS_CONFIG')
            env['janusgraph.storage.hostname']=','.join(names);name=prefix+'-j'+str(ordinal-2)
        nodes.append(dict(name=name,image=value['Image'],environment=env,command=value['Config']['Cmd'],memory=host['Memory'],memorySwap=host['MemorySwap'],cpus=1.5,kind='cassandra' if ordinal<3 else 'janus',sourceRuntime=runtime[ordinal]['process']))
    return nodes

def available_physical():
    class Memory(ctypes.Structure):
        _fields_=[('length',ctypes.c_ulong),('load',ctypes.c_ulong)]+[(n,ctypes.c_ulonglong) for n in ('totalPhys','availPhys','totalPageFile','availPageFile','totalVirtual','availVirtual','availExtendedVirtual')]
    m=Memory();m.length=ctypes.sizeof(m);require(ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))!=0,'GRAPH_HOST_MEMORY_READ')
    return m.availPhys

def ttl_horizon(metadata,remaining_seconds):
    earliest=min((v[1] for rows in metadata['beforeCatalog']['expirations'].values() for v in rows),default=float('inf'))
    require(time.time()+remaining_seconds+3600<earliest,'GRAPH_RESTORE_TTL_HORIZON_TOO_SHORT')
    return earliest
