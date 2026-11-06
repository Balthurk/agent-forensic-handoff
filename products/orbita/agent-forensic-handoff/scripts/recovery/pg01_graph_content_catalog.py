"""Complete graph content digest through the qualified read-only Janus adapter.

Native IDs, every property value and every incoming/outgoing edge are included.
Ordering of sets is canonical; multiplicity is retained. No ideal-plan rebuild.
"""
import hashlib,time
from orbita_store.config import require
from orbita_store.service_archive import canonical

def full_graph(client,scripts,*,deadline,progress):
    readers=[];schema=client.schema()
    for endpoint in client.endpoints:
        require(time.monotonic()<deadline,'GRAPH_CONTENT_DEADLINE')
        before=client.request(endpoint,scripts['ids'],dict(maximum=100001))
        require(isinstance(before,list) and len(before)<=100000 and all(type(v) is int for v in before),'GRAPH_NATIVE_ID_BUDGET')
        require(len(set(before))==len(before),'GRAPH_DUPLICATE_NATIVE_ID')
        before.sort();vertices={};edges={};directions={};payload=0;properties=set()
        for offset in range(0,len(before),150):
            require(time.monotonic()<deadline,'GRAPH_CONTENT_DEADLINE')
            ids=before[offset:offset+150]
            values=client.request(endpoint,scripts['content'],dict(nativeIds=ids))
            require(isinstance(values,list) and sorted(v['id'] for v in values)==ids,'GRAPH_BATCH_MEMBERSHIP')
            for vertex in values:
                require(set(vertex)=={'id','label','properties','incoming','outgoing'},'GRAPH_VERTEX_FIELDS')
                require(isinstance(vertex['properties'],dict),'GRAPH_PROPERTY_FORMAT')
                properties.update(vertex['properties'])
                for name,values in vertex['properties'].items():
                    require(isinstance(values,list),'GRAPH_PROPERTY_MULTIPLICITY')
                    vertex['properties'][name]=sorted(values,key=canonical)
                    if name=='orbitaPayload':
                        require(all(isinstance(v,str) for v in values),'GRAPH_PAYLOAD_TYPE')
                        payload+=sum(len(v.encode('utf8')) for v in values)
                for direction in ('outgoing','incoming'):
                    require(isinstance(vertex[direction],list),'GRAPH_EDGE_FORMAT')
                    seen=set()
                    for edge in vertex[direction]:
                        require(set(edge)=={'id','label','from','to','properties'},'GRAPH_EDGE_FIELDS')
                        require(type(edge['from']) is int and type(edge['to']) is int and isinstance(edge['id'],str),'GRAPH_EDGE_IDENTITY')
                        require(edge['id'] not in seen,'GRAPH_DUPLICATE_DIRECTION_EDGE');seen.add(edge['id'])
                        require(edge['from' if direction=='outgoing' else 'to']==vertex['id'],'GRAPH_EDGE_ENDPOINT')
                        for key,vals in edge['properties'].items():
                            require(isinstance(vals,list),'GRAPH_EDGE_PROPERTY_MULTIPLICITY');edge['properties'][key]=sorted(vals,key=canonical)
                        digest=hashlib.sha256(canonical(edge)).hexdigest()
                        require(edge['id'] not in edges or edges[edge['id']]==digest,'GRAPH_EDGE_CONTENT_CHANGED')
                        edges[edge['id']]=digest
                        directions.setdefault(edge['id'],[]).append(direction)
                    vertex[direction].sort(key=lambda e:e['id'])
                vertices[str(vertex['id'])]=hashlib.sha256(canonical(vertex)).hexdigest()
            if offset%3000==0:progress('graph-reader',endpoint=endpoint,vertices=len(vertices),edges=len(edges))
        after=client.request(endpoint,scripts['ids'],dict(maximum=100001))
        require(sorted(after)==before,'GRAPH_NATIVE_IDENTITIES_CHANGED')
        require(all(sorted(v)==['incoming','outgoing'] for v in directions.values()),'GRAPH_EDGE_RECIPROCITY')
        logical=dict(format='orbita-complete-janus-graph-hashes-1',schemaConfiguration=schema,vertexHashes=vertices,edgeHashes=edges,
                     vertices=len(vertices),edges=len(edges),payloadBytes=payload,propertyNames=sorted(properties))
        readers.append(dict(endpoint=endpoint,logical=logical,sha256=hashlib.sha256(canonical(logical)).hexdigest(),identitiesUnchanged=True))
        progress('graph-reader-complete',endpoint=endpoint,vertices=len(vertices),edges=len(edges),sha256=readers[-1]['sha256'])
    require(len(readers)==2 and readers[0]['logical']==readers[1]['logical'],'GRAPH_COMPLETE_READERS_DIFFER')
    return dict(status='PASS_TWO_COMPLETE_GRAPH_READERS',readers=readers,sha256=readers[0]['sha256'],payloadsPersisted=False)

def same_cells(before,after):
    """Compare every native cell and schema byte; intersect measured TTL bounds."""
    require(before['logical']==after['logical'],'GRAPH_COMPLETE_NATIVE_CELLS_CHANGED')
    intersections={}
    require(set(before['expirations'])==set(after['expirations']),'GRAPH_EXPIRY_TABLES_CHANGED')
    for table,left in before['expirations'].items():
        right=after['expirations'][table]
        require(len(left)==len(right),'GRAPH_EXPIRY_COUNT_CHANGED')
        rows=[]
        for a,b in zip(left,right,strict=True):
            require(a[0]==b[0],'GRAPH_EXPIRY_IDENTITY_CHANGED')
            low=max(a[1],b[1]);high=min(a[2],b[2])
            require(low<=high,'GRAPH_EXPIRY_CLOCK_INTERVALS_DISJOINT')
            rows.append([a[0],low,high])
        intersections[table]=rows
    return dict(status='PASS_ALL_NATIVE_CELLS_AND_EXPIRY_INTERVALS',logicalSha256=before['logicalSha256'],expiryIntersections=intersections)
