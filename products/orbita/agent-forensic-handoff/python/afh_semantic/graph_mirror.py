"""Bounded relational graph mirror in the single common PostgreSQL database.

The operation tokens are fixed local commands, never scripts or endpoints.
Two held independent readers share a snapshot; a fresh final read detects
changes made during bounded readback. No HTTP/Gremlin or native storage path.
"""
import contextlib,json,os,sys
from pathlib import Path as NativePath
from .common_backend import connect
from .graph_publication import digest,require,MAX_BYTES
from .knowledge_records import _json,RecordError
from .graph_snapshot import import_snapshot
from orbita_store.config import binding_for

SCHEMA='schema';UPSERT='upsert';LINKS='links';MEMBERS='members';READ='read';READ_BATCH='read-batch'
DDL=(NativePath(__file__).parent.parent/'orbita_store/schemas/graph_mirror.sql').read_text(encoding='utf8')
FORMAT={'schema':'orbita-common-graph-mirror-1','storeFamily':'graph_mirror'}

def binding(records):
    bound,key=binding_for(records.path,records.db.config)
    require(records.db.family=='semantic' and bound==records.db.session.binding,'G1_COMMON_BINDING_REQUIRED')
    records.db.raw.execute('SELECT orbita_common.workspace_id()').fetchone()
    return dict(identity=digest(FORMAT),namespace=digest(FORMAT)[:32],root=records.path.parent/'graph-publications',records=records)

class CommonGraph:
    def __init__(self,admission):
        self.admission=admission;self.root=admission['root'];self.path=self.root/'mirror.pgstore'
        self.records=admission['records'];self.endpoints=('reader:0','reader:1');self.sequence=0;self._views=None
    def progress(self,stage,completed):
        if os.environ.get('AFH_G1_PROGRESS')=='1':
            self.sequence+=1
            print('ORBITA_G1_PROGRESS '+json.dumps(dict(schema=1,sequence=self.sequence,stage=stage,completed=completed)),file=sys.stderr,flush=True)
    def connection(self,*,write=False):
        if write:self.root.mkdir(parents=True,exist_ok=True)
        require(write or self.path.is_file(),'G1_REMOTE_PROJECTION_MISSING')
        db=connect(self.path,family='graph_mirror',read_only=not write);db.row_factory=None
        try:
            if write:db.executescript(DDL)
            require(db.config==self.records.db.config and db.session.binding==self.records.db.session.binding,'G1_REMOTE_BINDING_CHANGED')
            return db
        except BaseException:db.close();raise
    def schema(self,create=False):
        with contextlib.closing(self.connection(write=create)) as db:
            columns={name:tuple(c['name'] for c in db.catalog[name]['columns']) for name in ('objects','links')}
            require(columns=={'objects':('uid','group_id','kind','key','payload'),'links':('owner_uid','label','target_uid')},'G1_REMOTE_SCHEMA_NOT_QUALIFIED')
            return dict(storage='postgresql-common',instanceId=db.config.instance_id,database=db.raw.execute('SELECT current_database()').fetchone()[0],family='graph_mirror')
    def group(self,p):return self.admission['namespace']+':'+p['generation']
    def objects(self,p,marker=False):
        rows=[dict(kind=v['kind'],key=v['key'],payload=_json(v)) for v in p['vertices']+p['edges']]
        if marker:rows.append(dict(kind='marker',key='marker',payload=_json({'planHash':digest(p),'readbackHash':digest(sorted((v['kind'],v['key'],_json(v)) for v in p['vertices']+p['edges']))})))
        for row in rows:row['uid']=digest([self.group(p),row['kind'],row['key']])
        return rows
    def expected(self,p,marker=False):
        rows=self.objects(p,marker);ids={r['key']:r['uid'] for r in rows};edges={e['key']:e for e in p['edges']}
        for row in rows:
            row.update(label='orbitaObject',properties=['orbitaGroup','orbitaKey','orbitaKind','orbitaPayload','orbitaUid'],links=[],incoming=[])
            if row['key'] in edges:
                edge=edges[row['key']];row['links']=[{'label':'orbita_from','target':ids[edge['from']]},{'label':'orbita_to','target':ids[edge['to']]}]
        byid={r['uid']:r for r in rows}
        for row in rows:
            for edge in row['links']:byid[edge['target']]['incoming'].append({'label':edge['label'],'source':row['uid']})
        for row in rows:row['incoming'].sort(key=lambda edge:edge['label']+edge['source'])
        return sorted(rows,key=lambda row:row['uid'])
    def request(self,endpoint,operation,values):
        require(endpoint in self.endpoints,'G1_REMOTE_READER_NOT_ADMITTED')
        require(operation in (UPSERT,LINKS,MEMBERS,READ_BATCH),'G1_REMOTE_OPERATION_NOT_ADMITTED')
        require(len(_json(values).encode())<=MAX_BYTES*2,'G1_REMOTE_REQUEST_BUDGET')
        writing=operation in (UPSERT,LINKS)
        if writing:
            require(endpoint==self.endpoints[0] and self._views is None,'G1_REMOTE_WRITE_SCOPE')
            with contextlib.closing(self.connection(write=True)) as db:
                db.execute('BEGIN IMMEDIATE')
                try:result=self._request(db,operation,values);db.commit();return result
                except BaseException:db.rollback();raise
        if self._views is not None:return self._request(self._views[self.endpoints.index(endpoint)],operation,values)
        with contextlib.closing(self.connection()) as db:return self._request(db,operation,values)
    def _request(self,db,operation,values):
        if operation==UPSERT:
            rows=values['rows'];require(isinstance(rows,list) and 0<len(rows)<=50,'G1_REMOTE_WRITE_BATCH')
            for row in rows:
                expected=(values['group'],row['kind'],row['key'],row['payload'])
                prior=db.execute('SELECT group_id,kind,key,payload FROM objects WHERE uid=?',(row['uid'],)).fetchone()
                if prior:require(prior==expected,'G1_REMOTE_IMMUTABLE_OBJECT_MISMATCH')
                else:db.execute('INSERT INTO objects VALUES(?,?,?,?,?)',(row['uid'],*expected))
            return {'written':len(rows)}
        if operation==LINKS:
            rows=values['rows'];require(isinstance(rows,list) and 0<len(rows)<=50,'G1_REMOTE_WRITE_BATCH')
            for row in rows:
                for label in ('orbita_from','orbita_to'):
                    prior=db.execute('SELECT target_uid FROM links WHERE owner_uid=? AND label=?',(row['uid'],label)).fetchone()
                    if prior:require(prior==(row[label],),'G1_REMOTE_IMMUTABLE_LINK_MISMATCH')
                    else:db.execute('INSERT INTO links VALUES(?,?,?)',(row['uid'],label,row[label]))
            return {'linked':len(rows)}
        if operation==MEMBERS:
            require(type(values['maximum']) is int and values['maximum']>0,'G1_REMOTE_READ_BUDGET')
            return [dict(uid=uid,id=rowid) for uid,rowid in db.execute('SELECT uid,rowid FROM objects WHERE group_id=? ORDER BY uid LIMIT ?',(values['group'],values['maximum']))]
        ids=values['nativeIds'];require(isinstance(ids,list) and 0<len(ids)<=150 and all(type(i) is int for i in ids),'G1_REMOTE_READ_BATCH')
        marks=','.join('?' for _ in ids)
        headers=db.execute('SELECT rowid,uid,length(CAST(payload AS BLOB)) FROM objects WHERE group_id=? AND rowid IN ('+marks+') ORDER BY uid',[values['group'],*ids]).fetchall()
        require(len(headers)==len(ids) and sum(r[2] for r in headers)<=MAX_BYTES*3,'G1_REMOTE_READBACK_MISMATCH')
        uids=[r[1] for r in headers];umarks=','.join('?' for _ in uids)
        count=db.execute('SELECT COUNT(*) FROM links WHERE owner_uid IN ('+umarks+') OR target_uid IN ('+umarks+')',[*uids,*uids]).fetchone()[0]
        require(count<=values['maxLinks'],'G1_REMOTE_READBACK_MISMATCH')
        edges=db.execute('SELECT owner_uid,label,target_uid FROM links WHERE owner_uid IN ('+umarks+') OR target_uid IN ('+umarks+')',[*uids,*uids]).fetchall()
        rows=[]
        for uid,kind,key,payload in db.execute('SELECT uid,kind,key,payload FROM objects WHERE group_id=? AND rowid IN ('+marks+') ORDER BY uid',[values['group'],*ids]):
            rows.append(dict(label='orbitaObject',uid=uid,kind=kind,key=key,payload=payload,properties=['orbitaGroup','orbitaKey','orbitaKind','orbitaPayload','orbitaUid'],
                links=sorted([dict(label=label,target=target) for owner,label,target in edges if owner==uid],key=lambda e:e['label']+e['target']),
                incoming=sorted([dict(label=label,source=owner) for owner,label,target in edges if target==uid],key=lambda e:e['label']+e['source'])))
        require(len(_json(rows).encode())<=MAX_BYTES*3,'G1_REMOTE_RESPONSE_BUDGET');return rows
    def write(self,p):
        rows=self.objects(p);group=self.group(p)
        for start in range(0,len(rows),50):self.request(self.endpoints[0],UPSERT,{'group':group,'rows':rows[start:start+50]});self.progress('objects',min(start+50,len(rows)))
        ids={r['key']:r['uid'] for r in rows};links=[dict(uid=ids[e['key']],orbita_from=ids[e['from']],orbita_to=ids[e['to']]) for e in p['edges']]
        for start in range(0,len(links),50):self.request(self.endpoints[0],LINKS,{'rows':links[start:start+50]});self.progress('links',min(start+50,len(links)))
    def _verify_reader(self,p,expected,endpoint,marker,*,request=None):
        request=request or self.request;ids=[r['uid'] for r in expected];group=self.group(p);bounds={'group':group,'maximum':len(expected)+2}
        before=request(endpoint,MEMBERS,bounds);normalized=[r['uid'] for r in before]
        if not marker:
            marker_uid=self.objects(p,True)[-1]['uid']
            if marker_uid in normalized:normalized.remove(marker_uid)
        require(normalized==ids,'G1_REMOTE_READBACK_MISMATCH');native_ids={r['uid']:r['id'] for r in before};rows=[]
        for start in range(0,len(ids),150):
            wanted=expected[start:start+150]
            batch=request(endpoint,READ_BATCH,dict(group=group,nativeIds=[native_ids[uid] for uid in ids[start:start+150]],maxLinks=sum(len(r['links'])+len(r['incoming']) for r in wanted)))
            require(batch==wanted,'G1_REMOTE_READBACK_MISMATCH');rows.extend(batch);self.progress('readback',len(rows))
        require(request(endpoint,MEMBERS,bounds)==before,'G1_REMOTE_MEMBERSHIP_CHANGED')
        require(rows==expected,'G1_REMOTE_READBACK_MISMATCH');return digest(rows),before
    def verify(self,p,marker=True,*,readers=None):
        require(self._views is None,'G1_REMOTE_READ_ALREADY_ACTIVE');expected=self.expected(p,marker);owned=readers is None;readers=[] if owned else list(readers);observed=[];members=[]
        try:
            source=self.records.db
            if owned:
                require(not source.in_transaction or source.raw.execute('SHOW transaction_isolation').fetchone()[0]!='repeatable read','G1_REMOTE_READERS_MUST_PRECEDE_SNAPSHOT')
                readers.append(self.connection());readers.append(self.connection())
            require(len(readers)==2,'G1_REMOTE_TWO_READERS_REQUIRED')
            require(len({r.raw.info.backend_pid for r in readers})==2,'G1_REMOTE_TWO_READERS_REQUIRED')
            if owned:
                readers[0].raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
                snapshot=readers[0].raw.execute('SELECT pg_export_snapshot()').fetchone()[0];import_snapshot(readers[1],snapshot)
            else:
                require(all(r.in_transaction and r.raw.execute('SHOW transaction_isolation').fetchone()[0]=='repeatable read' and r.raw.execute('SHOW transaction_read_only').fetchone()[0]=='on' for r in readers),'G1_REMOTE_SHARED_SNAPSHOT_REQUIRED')
            self._views=readers
            for endpoint in self.endpoints:
                h,ids=self._verify_reader(p,expected,endpoint,marker);observed.append(h);members.append(ids);self.progress('readback',len(observed))
            require(members[0]==members[1],'G1_REMOTE_READERS_DIFFERENT_BACKEND')
            with contextlib.closing(self.connection()) as fresh:
                require(fresh.raw.info.backend_pid not in {r.raw.info.backend_pid for r in readers},'G1_REMOTE_INDEPENDENT_READER_REQUIRED')
                fresh.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
                before=self._request(fresh,MEMBERS,dict(group=self.group(p),maximum=len(expected)+2))
                require(before==members[0],'G1_REMOTE_MEMBERSHIP_CHANGED')
                final,_=self._verify_reader(p,expected,self.endpoints[0],marker,request=lambda endpoint,operation,values:self._request(fresh,operation,values))
                require(all(h==final for h in observed),'G1_REMOTE_READBACK_MISMATCH')
            return observed
        finally:
            self._views=None
            error=None
            for reader in readers if owned else ():
                try:reader.close()
                except Exception:error=RecordError('G1_REMOTE_READER_CLOSE_UNVERIFIED')
            if error:raise error
    def marker(self,p):
        self.request(self.endpoints[0],UPSERT,{'group':self.group(p),'rows':[r for r in self.objects(p,True) if r['kind']=='marker']})
