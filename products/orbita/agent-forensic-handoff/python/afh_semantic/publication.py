"""Local derived search publication, driven by the existing atomic record outbox.

This adapter does not claim to implement a remote graph publication protocol.
Every indexed row binds one immutable N04 version; acknowledgment is replayable.
"""
import json, time, uuid, hashlib
from .knowledge_records import RecordError, _json

def require(value, code):
    if not value: raise RecordError(code)

def dispatch_publication(records, request):
    db=records.db;scope=request['scope'];op=request['op']
    db.executescript('''CREATE TABLE IF NOT EXISTS afh_publication_jobs (
        outbox_id TEXT PRIMARY KEY,state TEXT,owner TEXT,fence INTEGER NOT NULL DEFAULT 0,lease REAL NOT NULL DEFAULT 0,error TEXT);
        CREATE TABLE IF NOT EXISTS afh_publication_events(seq INTEGER PRIMARY KEY,outbox_id TEXT,at REAL,state TEXT,detail TEXT);
        CREATE TABLE IF NOT EXISTS afh_publications(outbox_id TEXT PRIMARY KEY,record_id TEXT,version INTEGER,payload_hash TEXT,text TEXT);
        CREATE VIRTUAL TABLE IF NOT EXISTS afh_publication_fts USING fts5(outbox_id UNINDEXED,text);''')
    def emit(oid,state,detail):db.execute('INSERT INTO afh_publication_events(outbox_id,at,state,detail) VALUES(?,?,?,?)',(oid,time.time(),state,_json(detail)))
    def validate(oid):
        out=records.g1_outbox_entry(oid);require(out['scope']==scope,'PUBLICATION_SCOPE')
        record=records.get(out['record_id'],scope,version=out['record_version'])
        encoded=_json(record['payload']);require(hashlib.sha256(encoded.encode()).hexdigest()==out['payload_sha256'],'PUBLICATION_BINDING')
        return out,record
    with db:db.execute("INSERT OR IGNORE INTO afh_publication_jobs(outbox_id,state) SELECT outbox_id,'pending' FROM g1_projection_outbox WHERE scope=?",(scope,))
    if op=='publication_status':
        rows=[];excluded=0
        for job in db.execute('SELECT j.* FROM afh_publication_jobs j JOIN g1_projection_outbox o USING(outbox_id) WHERE o.scope=?',(scope,)).fetchall():
            try:validate(job['outbox_id']);rows.append(dict(job))
            except RecordError:excluded+=1
        return {'jobs':rows,'excludedUnavailableSources':excluded,'adapter':'local-search-v1','approval':'none'}
    if op=='publication_claim':
        owner=request.get('owner') or str(uuid.uuid4());limit=request.get('limit',20);lease=request.get('leaseSeconds',60)
        require(type(limit) is int and 1<=limit<=100 and isinstance(lease,(int,float)) and 0<lease<=600,'PUBLICATION_LIMIT')
        db.execute('BEGIN IMMEDIATE')
        try:
            claimed=[]
            for job in db.execute("SELECT j.* FROM afh_publication_jobs j JOIN g1_projection_outbox o USING(outbox_id) WHERE o.scope=? AND (j.state IN ('pending','failed') OR (j.state='claimed' AND j.lease<?)) ORDER BY o.created_at LIMIT ?",(scope,time.time(),limit)).fetchall():
                try:validate(job['outbox_id'])
                except RecordError:continue
                db.execute("UPDATE afh_publication_jobs SET state='claimed',owner=?,fence=fence+1,lease=?,error=NULL WHERE outbox_id=?",(owner,time.time()+lease,job['outbox_id']));emit(job['outbox_id'],'claimed',{'owner':owner,'fence':job['fence']+1})
                claimed.append(dict(db.execute('SELECT * FROM afh_publication_jobs WHERE outbox_id=?',(job['outbox_id'],)).fetchone()))
            db.commit();return claimed
        except Exception:db.rollback();raise
    if op in ['publication_publish','publication_ack','publication_fail']:
        db.execute('BEGIN IMMEDIATE')
        try:
            oid=request['outboxId'];job=db.execute('SELECT * FROM afh_publication_jobs WHERE outbox_id=?',(oid,)).fetchone()
            require(job is not None and job['state']=='claimed' and job['owner']==request['owner'] and job['fence']==request['fence'] and job['lease']>=time.time(),'PUBLICATION_STALE_FENCE')
            out,record=validate(oid);payload=record['payload'];text=payload['text']+' '+_json(payload.get('semantic_unit',{}))
            if op=='publication_publish':
                prior=db.execute('SELECT * FROM afh_publications WHERE outbox_id=?',(oid,)).fetchone()
                if prior:require(prior['payload_hash']==out['payload_sha256'] and prior['text']==text,'PUBLICATION_REPLAY_CONFLICT')
                else:
                    db.execute('INSERT INTO afh_publications VALUES(?,?,?,?,?)',(oid,out['record_id'],out['record_version'],out['payload_sha256'],text))
                    db.execute('INSERT INTO afh_publication_fts VALUES(?,?)',(oid,text))
                emit(oid,'index_durable',{'payloadHash':out['payload_sha256']})
            elif op=='publication_ack':
                row=db.execute('SELECT * FROM afh_publications WHERE outbox_id=?',(oid,)).fetchone();require(row is not None and row['payload_hash']==out['payload_sha256'] and row['text']==text,'PUBLICATION_READBACK_FAILED')
                require(db.execute('SELECT COUNT(*) FROM afh_publication_fts WHERE outbox_id=? AND text=?',(oid,text)).fetchone()[0]==1,'PUBLICATION_INDEX_READBACK_FAILED')
                db.execute("UPDATE afh_publication_jobs SET state='published',owner=NULL,lease=0 WHERE outbox_id=?",(oid,));emit(oid,'published',{'fence':job['fence']})
            else:
                db.execute("UPDATE afh_publication_jobs SET state='failed',error=?,owner=NULL,lease=0 WHERE outbox_id=?",(request.get('error','unknown'),oid));emit(oid,'failed',{'error':request.get('error')})
            db.commit();return {'outboxId':oid,'recordId':out['record_id'],'version':out['record_version'],'state':op.removeprefix('publication_')}
        except Exception:db.rollback();raise
    if op=='publication_query':
        terms=[x for x in str(request.get('question','')).split() if len(x)>2][:12]
        if not terms:return {'items':[],'status':'no_query_terms'}
        query=' OR '.join('"'+t.replace('"','""')+'"' for t in terms);items=[];excluded=0
        rows=db.execute("SELECT p.* FROM afh_publication_fts f JOIN afh_publications p ON p.outbox_id=f.outbox_id JOIN afh_publication_jobs j ON j.outbox_id=p.outbox_id JOIN g1_projection_outbox o ON o.outbox_id=p.outbox_id WHERE afh_publication_fts MATCH ? AND j.state='published' AND o.scope=? AND p.version=(SELECT MAX(version) FROM record_versions WHERE record_id=p.record_id) LIMIT 100",(query,scope)).fetchall()
        for row in rows:
            try:
                out,record=validate(row['outbox_id']);require(out['payload_sha256']==row['payload_hash'],'PUBLICATION_CORRUPT');items.append({'outboxId':row['outbox_id'],'record':record})
            except RecordError:excluded+=1
        return {'items':items,'excludedUnavailableSources':excluded,'status':'published_local_index','approval':'none'}
    raise RecordError('UNKNOWN_PUBLICATION_OPERATION')
