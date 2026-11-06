"""Read-only bounded probe, executed inside the explicitly identified Cassandra4.0.6 container."""
import glob,hashlib,json,math,os,struct,sys,threading,time
prefix='cassandra-driver-internal-only-'
archive=max(glob.glob('/opt/cassandra/lib/'+prefix+'*.zip'))
version=os.path.basename(archive)[len(prefix):-4]
sys.path.insert(0,archive+'/cassandra-driver-'+version)
for name in ('six-','futures-'):
    files=glob.glob('/opt/cassandra/lib/'+name+'*.zip')
    if files:sys.path.insert(0,max(files))
from cassandra import ConsistencyLevel,__version__
from cassandra.cluster import Cluster
from cassandra.query import SimpleStatement

TABLES=['edgestore','edgestore_lock_','graphindex','graphindex_lock_','janusgraph_ids','system_properties','system_properties_lock_','systemlog','txlog']
canonical=lambda v:json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
def frame(v):
    if v is None:return b'N'
    assert isinstance(v,bytes)
    return b'B'+struct.pack('>Q',len(v))+v
begun=time.time();timer=threading.Timer(180,lambda:os._exit(124));timer.daemon=True;timer.start()
cluster=None
try:
    cluster=Cluster(['127.0.0.1'],connect_timeout=5,control_connection_timeout=5)
    session=cluster.connect();session.default_timeout=8;session.default_fetch_size=500
    assert __version__=='3.25.0'
    user=sorted(k for k in cluster.metadata.keyspaces if not k.startswith('system'))
    assert user==['orbita_f30']
    ks=cluster.metadata.keyspaces['orbita_f30']
    assert sorted(ks.tables)==TABLES and not ks.user_types and not ks.functions and not ks.aggregates
    local=session.execute("SELECT cluster_name,release_version,partitioner,host_id,data_center,rack FROM system.local").one()
    assert local.release_version=='4.0.6' and local.partitioner=='org.apache.cassandra.dht.Murmur3Partitioner'
    physical=session.execute("SELECT table_name,id FROM system_schema.tables WHERE keyspace_name='orbita_f30'")
    physical_tables={r.table_name:str(r.id) for r in physical}
    values={};expirations={};total_rows=total_bytes=0;pages=0
    for name in TABLES:
        meta=ks.tables[name]
        assert {k:v.cql_type for k,v in meta.columns.items()}==dict(key='blob',column1='blob',value='blob')
        assert [c.name for c in meta.partition_key]==['key'] and [c.name for c in meta.clustering_key]==['column1']
        assert not meta.indexes
        query=SimpleStatement('SELECT key,column1,value,writetime(value) AS written,ttl(value) AS remaining FROM orbita_f30.'+name,consistency_level=ConsistencyLevel.QUORUM,fetch_size=500)
        entries=[];ttl=[];seen=set();page_start=time.time();result=session.execute(query);page_end=time.time()
        while True:
            pages+=1
            for row in result.current_rows:
                key,column,value=row.key,row.column1,row.value
                assert isinstance(key,bytes) and isinstance(column,bytes) and (value is None or isinstance(value,bytes))
                assert row.written is None or type(row.written) is int
                assert row.remaining is None or (type(row.remaining) is int and row.remaining>=0)
                identity=hashlib.sha256(frame(key)+frame(column)).hexdigest();assert identity not in seen;seen.add(identity)
                encoded=frame(key)+frame(column)+frame(value)+(b'N' if row.written is None else b'I'+struct.pack('>q',row.written))+(b'P' if row.remaining is None else b'E')
                total_rows+=1;total_bytes+=len(encoded)
                assert total_rows<=1000000 and total_bytes<=1024**3
                entries.append([identity,hashlib.sha256(encoded).hexdigest(),len(encoded)])
                if row.remaining is not None:
                    # TTL is computed by Cassandra during this measured page
                    # request. Keep its real-clock interval, never reset it.
                    ttl.append([identity,math.floor(page_start)+row.remaining,math.floor(page_end)+row.remaining+1,row.remaining])
            if not result.has_more_pages:break
            page_start=time.time();result.fetch_next_page();page_end=time.time()
        entries.sort();ttl.sort();expirations[name]=ttl
        values[name]=dict(rows=len(entries),typedBytes=sum(x[2] for x in entries),entries=entries,sha256=hashlib.sha256(canonical(entries)).hexdigest())
    logical=dict(format='orbita-cassandra-full-cells-1',keyspace='orbita_f30',schemaCql=ks.export_as_string(),partitioner=local.partitioner,tables=values)
    output=dict(status='PASS_COMPLETE_READ_ONLY_CASSANDRA_CELLS',logical=logical,logicalSha256=hashlib.sha256(canonical(logical)).hexdigest(),expirations=expirations,clockStart=begun,clockEnd=time.time(),clockBasis='Docker Linux real UTC clock, page request begin/end bounds, one-second TTL quantization retained',minimumObservedTtl=min((r[3] for rows in expirations.values() for r in rows),default=None),rows=total_rows,typedBytes=total_bytes,pages=pages,driverVersion=__version__,clusterName=local.cluster_name,hostId=str(local.host_id),physicalTables=physical_tables,dataCenter=local.data_center,rack=local.rack,readConsistency='QUORUM',mutations=False)
finally:
    if cluster is not None:cluster.shutdown()
    timer.cancel()
raw=canonical(output);assert len(raw)<=64*1024**2
sys.stdout.buffer.write(raw+b'\n')
