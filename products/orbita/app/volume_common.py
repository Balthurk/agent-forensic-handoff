"""Bounded original-record volumes and analytic projections in one PostgreSQL.

Native Parquet exists only after an explicit export to a new external folder.
Every operational reader uses the common database and exact workspace binding.
"""
import base64, contextlib, hashlib, hmac, json, os, pathlib, secrets, sys, time, uuid
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent/'agent-forensic-handoff/python'))
from psycopg import sql
from afh_semantic.path_safety import plain_path, PathSafetyError
from orbita_store.config import read_config
from orbita_store.connection import Connection, Row
from orbita_store.paths import Path

PRIMARY='postgresql-common'
ANALYTICS='postgresql-analytics'
BATCH=8*1024**2
COLUMNS='seq,source_id,uri,kind,raw,payload,row_hash'
SCHEMA=(pathlib.Path(__file__).resolve().parent.parent/'agent-forensic-handoff/python/orbita_store/schemas/volume.sql').read_text(encoding='utf8')

class VolumeError(Exception): pass
def demand(ok, code):
    if not ok: raise VolumeError('VOLUME_'+code)
def canonical(value): return json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':'))
def digest(value): return hashlib.sha256(value if isinstance(value,bytes) else value.encode('utf8')).hexdigest()
def filehash(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''): h.update(block)
    return h.hexdigest()
def plain(p):
    try: return plain_path(p)
    except PathSafetyError as e: raise VolumeError('VOLUME_'+str(e)) from e
def crash(point):
    if os.environ.get('AFH_VOLUME_CRASH_AT')==point: os._exit(86)


class Store:
    def __init__(self, root):
        root=plain(root)
        self.config=read_config();self.root=Path(root,config=self.config);self.path=self.root/'volume'
        self.path.mkdir(parents=True,exist_ok=True);self.analytics_path=self.path/'analytical.pgstore'
        self.db=self._connect(self.path/'operational.pgstore',write=True)
        try:
            with self.tx():
                if not self.get('instance'):
                    for k,v in dict(instance=str(uuid.uuid4()),secret=secrets.token_hex(32),schema='2',catalog='',token='',generation='').items(): self.set(k,v)
                demand(self.get('schema')=='2','SCHEMA_REQUIRES_EXPLICIT_MIGRATION')
        except BaseException:self.close();raise

    def _connect(self, path, *, write=False):
        db=Connection(path,family='volume',config=self.config,read_only=not write,create=write)
        db.row_factory=Row
        try:
            if write: db.executescript(SCHEMA)
            return db
        except BaseException:db.close();raise

    def close(self): self.db.close()

    @contextlib.contextmanager
    def tx(self, db=None):
        db=db or self.db;db.begin_consistent_write()
        try:yield;db.commit()
        except BaseException:
            if not db.closed:db.rollback()
            raise

    @contextlib.contextmanager
    def readers(self, *, projection=True):
        demand(not self.db.in_transaction,'TRANSACTION_ALREADY_ACTIVE')
        other=self._connect(self.analytics_path) if projection and self.analytics_path.is_file() else None
        try:
            self.db.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
            if other:
                snapshot=self.db.raw.execute('SELECT pg_export_snapshot()').fetchone()[0]
                other.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
                other.raw.execute(sql.SQL('SET TRANSACTION SNAPSHOT {}').format(sql.Literal(snapshot)))
                demand(other.raw.info.backend_pid!=self.db.raw.info.backend_pid,'INDEPENDENT_READER_REQUIRED')
            yield other
        finally:
            try:
                if other:other.close()
            finally:
                if not self.db.closed:self.db.rollback()

    def get(self,k,db=None):
        r=(db or self.db).execute('SELECT v FROM meta WHERE k=?',(k,)).fetchone();return r[0] if r else None
    def set(self,k,v,db=None):
        (db or self.db).execute('INSERT INTO meta VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v',(k,str(v)))
    def catalog(self):return json.loads(self.get('catalog')) if self.get('catalog') else []

    def prepare(self,catalog):
        sources=catalog['sources'];demand(isinstance(sources,list) and len(sources)<=10000,'CATALOG_LIMIT')
        demand(len(canonical(sources).encode())<=BATCH,'CATALOG_LIMIT')
        demand(catalog['token']==digest(canonical(sources)),'CATALOG_HASH');ids=[s['id'] for s in sources]
        demand(len(ids)==len(set(ids)) and all(isinstance(i,str) and i and len(i)<=180 for i in ids),'SOURCE_IDS')
        with self.tx():
            for s in sources:
                prior=self.db.execute('SELECT * FROM sources WHERE id=?',(s['id'],)).fetchone()
                if prior:demand(prior['case_hash']==s['caseHash'] and prior['manifest_hash']==s['manifestHash'],'SOURCE_REBOUND')
                else:self.db.execute('INSERT INTO sources(id,case_hash,manifest_hash) VALUES(?,?,?)',(s['id'],s['caseHash'],s['manifestHash']))
            if catalog['token']!=self.get('token'):
                self.set('catalog',canonical(sources));self.set('token',catalog['token']);self.set('generation',str(uuid.uuid4()))
        return self.status()

    def _status(self,other=None):
        pending=[];expected=0
        for s in self.catalog():
            row=self.db.execute('SELECT * FROM sources WHERE id=?',(s['id'],)).fetchone();demand(row is not None,'SOURCE_MISSING');expected+=row['records']
            if not row['complete']:pending.append(dict(id=s['id'],after=row['after_ref']))
        high=self.db.execute('SELECT COALESCE(MAX(seq),0) FROM records').fetchone()[0]
        lc=int(self.get('cursor',other) or 0) if other else 0
        head=other.execute('SELECT cut,token FROM heads WHERE gen=?',(self.get('generation'),)).fetchone() if other else None
        return dict(schema='orbita-volume-2',storage=PRIMARY,instance=self.get('instance'),generation=self.get('generation'),catalogToken=self.get('token'),ready=bool(self.get('token')) and not pending,pending=pending,records=expected,storedRecords=self.db.execute('SELECT COUNT(*) FROM records').fetchone()[0],high=high,sources=len(self.catalog()),lake=dict(cursor=lc,parts=other.execute('SELECT COUNT(*) FROM parts').fetchone()[0] if other else 0,pendingRecords=max(0,high-lc),ready=bool(head and head[0]==high and lc==high and head[1]==self.get('token')),storage=ANALYTICS,verification='requires_explicit_verification'),semantics='Original historical records; no truth, current applicability or execution authority established')
    def status(self):
        with self.readers() as other:return self._status(other)

    def append(self,source,expected_after,after,rows,complete):
        demand(type(after)==int and type(expected_after)==int and after>=expected_after and isinstance(rows,list) and len(rows)<=500 and type(complete)==bool,'BATCH_INPUT')
        demand(sum(len(canonical(r).encode()) for r in rows)<=BATCH,'BATCH_BYTES')
        with self.tx():
            demand(source in [s['id'] for s in self.catalog()],'SOURCE_NOT_SELECTED')
            s=self.db.execute('SELECT * FROM sources WHERE id=?',(source,)).fetchone();demand(not s['complete'] and s['after_ref']==expected_after,'SOURCE_CURSOR_CONFLICT')
            added=0;seq=self.db.execute('SELECT COALESCE(MAX(seq),0) FROM records').fetchone()[0]
            for r in rows:
                demand(set(r)=={'sourceId','uri','ordinal','kind','raw','sha','caseHash'},'RECORD_SCHEMA')
                demand(r['sourceId']==source and r['caseHash']==s['case_hash'] and type(r['ordinal'])==int and r['ordinal']>=0 and isinstance(r['raw'],str) and digest(r['raw'])==r['sha'],'RECORD_BINDING')
                payload=canonical(r);h=digest(payload);old=self.db.execute('SELECT row_hash FROM records WHERE source_id=? AND uri=?',(source,r['uri'])).fetchone()
                if old:demand(old[0]==h,'RECORD_REBOUND');continue
                seq+=1;self.db.execute('INSERT INTO records VALUES(?,?,?,?,?,?,?)',(seq,source,r['uri'],r['kind'],r['raw'],payload,h));added+=1
            self.db.execute('UPDATE sources SET after_ref=?,complete=?,records=records+? WHERE id=?',(after,int(complete),added,source));crash('append-before-commit')
        return dict(added=added,processedReferences=after-expected_after,**self.status())

    def sign(self,data):
        raw=canonical(data).encode();return base64.urlsafe_b64encode(raw).decode().rstrip('=')+'.'+hmac.new(bytes.fromhex(self.get('secret')),raw,hashlib.sha256).hexdigest()
    def decode(self,token):
        try:
            demand(isinstance(token,str) and len(token)<8192,'CURSOR');encoded,mac=token.split('.');raw=base64.urlsafe_b64decode(encoded+'='*((-len(encoded))%4))
            demand(hmac.compare_digest(mac,hmac.new(bytes.fromhex(self.get('secret')),raw,hashlib.sha256).hexdigest()),'CURSOR');data=json.loads(raw);demand(canonical(data).encode()==raw,'CURSOR');return data
        except VolumeError:raise
        except Exception:raise VolumeError('VOLUME_CURSOR') from None

    def query(self,request,backend=PRIMARY):
        demand(backend in (PRIMARY,ANALYTICS),'BACKEND')
        with self.readers() as other:return self._query(request,backend,other)
    def _query(self,request,backend,other):
        state=self._status(other);demand(state['ready'],'PROJECTION_PENDING')
        selected=sorted(request.get('sourceIds') or [s['id'] for s in self.catalog()]);demand(len(selected)==len(set(selected)) and set(selected)<=set(s['id'] for s in self.catalog()),'SELECTION')
        limit=request.get('limit',200);q=request.get('query','');demand(type(limit)==int and 1<=limit<=200 and isinstance(q,str) and len(q)<=500,'QUERY_LIMIT')
        legacy=self.get('legacy_cursor_format')
        demand(legacy in (None,'orbita-volume-1'),'CURSOR_FORMAT')
        # Only an explicit imported volume retains the old signed namespace.
        # Both readers still use common PostgreSQL; no old engine is opened.
        cursor_backend=({'postgresql-common':'sqlite','postgresql-analytics':'postgres'}[backend] if legacy else backend)
        binding=dict(instance=state['instance'],generation=state['generation'],token=state['catalogToken'],selection=selected,query=q,backend=cursor_backend)
        after=0;high=state['high']
        if request.get('cursor'):
            token=self.decode(request['cursor']);demand(token.get('binding')==binding,'CURSOR_STALE');after=token.get('after');high=token.get('high');demand(type(after)==int and type(high)==int and 0<=after<=high<=state['high'],'CURSOR')
        db=self.db
        if backend==ANALYTICS:
            demand(other is not None and state['lake']['ready'],'ANALYTICS_BEHIND');db=other
        if not selected:return dict(rows=[],cursor=None,high=high,generation=state['generation'],catalogToken=state['catalogToken'],backend=backend,bytes=0,completePage=True,more=False,applicability='not_established',executionAuthority=False)
        placeholders=','.join('?' for _ in selected)
        expected=sum(self.db.execute('SELECT records FROM sources WHERE id=?',(s,)).fetchone()[0] for s in selected)
        actual=self.db.execute(f'SELECT COUNT(*) FROM records WHERE source_id IN ({placeholders})',selected).fetchone()[0];demand(actual==expected,'ROW_COUNT_CHANGED')
        actual=db.execute(f'SELECT COUNT(*) FROM records WHERE source_id IN ({placeholders})',selected).fetchone()[0];demand(actual==expected,'ANALYTICS_COUNT_CHANGED' if other is db else 'ROW_COUNT_CHANGED')
        metadata=db.execute(f'SELECT seq,length(CAST(payload AS BLOB)) FROM records WHERE seq>? AND seq<=? AND source_id IN ({placeholders}) AND instr(raw,?)>0 ORDER BY seq LIMIT ?', [after,high,*selected,q,limit+1]).fetchall()
        wanted=[];estimated=0;budget=2*1024**2;single_large=False
        for seq,n in metadata[:limit]:
            demand(n<=BATCH,'RECORD_EXCEEDS_RESPONSE_BUDGET')
            if n+200>budget:
                if wanted:break
                budget=BATCH+512;single_large=True
            if estimated+n+200>budget:break
            wanted.append(seq);estimated+=n+200
            if single_large:break
        more=len(metadata)>len(wanted)
        found=db.execute('SELECT seq,payload,row_hash FROM records WHERE seq IN ('+','.join('?' for _ in wanted)+') ORDER BY seq',wanted).fetchall() if wanted else []
        demand([r[0] for r in found]==wanted,'PAGE_CHANGED');rows=[];size=0
        for seq,payload,h in found:
            demand(digest(payload)==h,'ROW_HASH_CHANGED');value=json.loads(payload);demand(digest(value['raw'])==value['sha'],'RAW_HASH_CHANGED');value.update(seq=seq,rowHash=h)
            n=len(canonical(value).encode());demand(size+n<=budget,'RESPONSE_BUDGET');rows.append(value);size+=n
        cursor=self.sign(dict(binding=binding,high=high,after=rows[-1]['seq'])) if more and rows else None
        return dict(rows=rows,cursor=cursor,high=high,generation=state['generation'],catalogToken=state['catalogToken'],backend=backend,bytes=size,responseBudgetBytes=budget,singleLargeRecord=single_large,completePage=True,more=bool(cursor),applicability='not_established',executionAuthority=False)

    @staticmethod
    def batch(db,after,high,limit):
        headers=db.execute('SELECT seq,length(CAST(payload AS BLOB)) FROM records WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?',(after,high,limit)).fetchall()
        wanted=[];size=0
        for seq,n in headers:
            demand(n<=BATCH,'RECORD_TOO_LARGE')
            if wanted and size+n>BATCH:break
            wanted.append(seq);size+=n
        rows=db.execute('SELECT '+COLUMNS+' FROM records WHERE seq IN ('+','.join('?' for _ in wanted)+') ORDER BY seq',wanted).fetchall() if wanted else []
        demand([r['seq'] for r in rows]==wanted,'PAGE_CHANGED')
        for i,r in enumerate(rows):
            demand(r['seq']==after+i+1 and digest(r['payload'])==r['row_hash'],'ROW_HASH_OR_DELTA_CHANGED')
            value=json.loads(r['payload'])
            demand(value['raw']==r['raw'] and digest(value['raw'])==value['sha'] and value['sourceId']==r['source_id'] and value['uri']==r['uri'] and value['kind']==r['kind'],'RAW_BINDING_CHANGED')
        return rows

    def lake(self,limit=500):
        demand(type(limit)==int and 1<=limit<=500,'BATCH_LIMIT')
        target=self._connect(self.analytics_path,write=True)
        try:
            with self.readers(projection=False):
                state=self._status();demand(state['ready'],'PROJECTION_PENDING')
                with self.tx(target):
                    owner=self.get('instance',target)
                    demand(owner in (None,state['instance']),'ANALYTICS_INSTANCE')
                    cursor=int(self.get('cursor',target) or 0);demand(cursor<=state['high'],'ANALYTICS_AHEAD')
                    rows=self.batch(self.db,cursor,state['high'],limit)
                    for r in rows:target.execute('INSERT INTO records VALUES(?,?,?,?,?,?,?)',tuple(r))
                    if rows:
                        values=[dict(r) for r in rows];end=rows[-1]['seq']
                        # Legacy crash name now cuts the actual relational batch
                        # before publication; no native orphan is manufactured.
                        crash('lake-after-file')
                        target.execute('INSERT INTO parts VALUES(?,?,?,?,?,?)',(cursor+1,end,len(rows),'rows/'+str(cursor+1)+'-'+str(end),digest(canonical(values)),sum(len(r['payload'].encode()) for r in rows)))
                        cursor=end
                    self.set('instance',state['instance'],target);self.set('cursor',cursor,target)
                    if cursor==state['high']:
                        catalog=canonical(self.catalog());key='catalog:'+state['generation']
                        old=self.get(key,target);demand(old in (None,catalog),'ANALYTICS_CATALOG_REBOUND');self.set(key,catalog,target)
                        expected=(state['generation'],state['catalogToken'],state['high'],key,digest(catalog),max(1,state['sources']))
                        prior=target.execute('SELECT * FROM heads WHERE gen=?',(state['generation'],)).fetchone()
                        if prior:demand(tuple(prior)==expected,'ANALYTICS_HEAD_CHANGED')
                        else:target.execute('INSERT INTO heads VALUES(?,?,?,?,?,?)',expected)
                    crash('lake-before-commit');crash('postgres-before-commit')
                # A separate live backend reads the committed destination. It
                # cannot be the writer's pooled transport, which is still held.
                reader=self._connect(self.analytics_path)
                try:
                    demand(reader.raw.info.backend_pid!=target.raw.info.backend_pid,'INDEPENDENT_READER_REQUIRED')
                    got=reader.execute('SELECT '+COLUMNS+' FROM records WHERE seq>? AND seq<=? ORDER BY seq',(cursor-len(rows),cursor)).fetchall()
                    demand([tuple(r) for r in got]==[tuple(r) for r in rows],'ANALYTICS_READBACK')
                    demand(int(self.get('cursor',reader))==cursor,'ANALYTICS_CURSOR_READBACK')
                finally:reader.close()
            current=self.status();demand(current['catalogToken']==state['catalogToken'],'CATALOG_CHANGED')
            return dict(added=len(rows),cursor=cursor,cut=state['high'],ready=cursor==state['high'],readbackVerified=True,state=current)
        finally:target.close()

    def _verify(self,other):
        state=self._status(other);demand(state['ready'] and state['lake']['ready'],'LAKE_BEHIND')
        head=other.execute('SELECT * FROM heads WHERE gen=?',(state['generation'],)).fetchone();demand(head and head['token']==state['catalogToken'],'LAKE_HEAD')
        catalog=self.get(head['path'],other);demand(catalog is not None and digest(catalog)==head['sha'] and json.loads(catalog)==self.catalog(),'LAKE_CATALOG_BINDING')
        cursor=0;kinds={};files=[]
        for part in other.execute('SELECT * FROM parts WHERE hi<=? ORDER BY lo',(head['cut'],)):
            demand(part['lo']==cursor+1 and part['hi']-cursor==part['n'] and part['n']<=500,'LAKE_GAP')
            rows=self.batch(other,cursor,part['hi'],part['n']);originals=self.batch(self.db,cursor,part['hi'],part['n'])
            demand(len(rows)==part['n'] and [tuple(r) for r in rows]==[tuple(r) for r in originals],'LAKE_CANONICAL_PROJECTION_MISMATCH')
            demand(digest(canonical([dict(r) for r in rows]))==part['sha'] and sum(len(r['payload'].encode()) for r in rows)==part['bytes'],'LAKE_ROW_CHANGED')
            for row in rows:kinds[row['kind']]=kinds.get(row['kind'],0)+1
            cursor=part['hi'];files.append(dict(path=part['path'],sha256=part['sha'],rows=part['n'],storage=ANALYTICS))
        demand(cursor==head['cut'] and other.execute('SELECT COUNT(*) FROM records').fetchone()[0]==cursor,'LAKE_INCOMPLETE')
        return dict(status='VERIFIED',storage=ANALYTICS,records=cursor,currentSources=state['sources'],catalogToken=state['catalogToken'],generation=state['generation'],cut=cursor,kinds=kinds,files=files,catalogFile=head['path'],catalogSha256=head['sha'],scope='Historical original-record projection including retained superseded sources; not current factual validity')
    def verify_lake(self):
        with self.readers() as other:return self._verify(other)

    @staticmethod
    def parquet_write(folder,prefix,rows):
        import pyarrow as pa
        import pyarrow.parquet as pq
        name=prefix+'-'+str(uuid.uuid4())+'.parquet';final=plain(folder/name);temp=plain(folder/(name+'.partial'))
        demand(final.parent==folder and temp.parent==folder,'EXPORT_PATH')
        with temp.open('xb') as f:
            pq.write_table(pa.Table.from_pylist(rows),f,compression='zstd',row_group_size=500);f.flush();os.fsync(f.fileno())
        with temp.open('rb') as f:demand(pq.read_table(f).to_pylist()==rows,'PARQUET_READBACK')
        os.link(temp,final);temp.unlink();return final,filehash(final)

    def export_parquet(self,destination):
        demand(isinstance(destination,(str,os.PathLike)) and pathlib.Path(destination).is_absolute(),'EXPORT_PATH')
        folder=plain(destination)
        for binding in self.config.bindings:
            root=pathlib.Path(binding.root)
            demand(not folder.is_relative_to(root) and not root.is_relative_to(folder),'EXPORT_OVERLAPS_COMMON_ROOT')
        demand(not folder.exists(),'EXPORT_EXISTS');folder.mkdir()
        started=time.monotonic();total_bytes=0;files=[];export_id=str(uuid.uuid4())
        with self.readers() as other:
            verified=self._verify(other);cursor=0
            while cursor<verified['cut']:
                demand(time.monotonic()-started<120,'EXPORT_DEADLINE')
                rows=self.batch(other,cursor,verified['cut'],500);demand(rows,'EXPORT_DELTA_GAP')
                values=[dict(r) for r in rows];total_bytes+=sum(len(r['payload'].encode()) for r in rows)
                demand(total_bytes<=1024**3,'EXPORT_BYTE_BUDGET')
                file,h=self.parquet_write(folder,'part-'+str(cursor+1)+'-'+str(rows[-1]['seq']),values)
                files.append(dict(path=file.name,sha256=h,rows=len(rows)));cursor=rows[-1]['seq']
                crash('export-after-file')
            sources=[dict(source_id=s['id'],metadata=canonical(s),generation=verified['generation'],catalog_token=verified['catalogToken'],cut=cursor) for s in self.catalog()]
            if not sources:sources=[dict(source_id='',metadata='null',generation=verified['generation'],catalog_token=verified['catalogToken'],cut=cursor)]
            file,h=self.parquet_write(folder,'catalog',sources)
            result=dict(schema='orbita-volume-parquet-export-1',id=export_id,directory=str(folder),generation=verified['generation'],catalogToken=verified['catalogToken'],records=cursor,files=files,catalogFile=file.name,catalogSha256=h)
        with self.tx():
            demand(self.get('export:'+export_id) is None,'EXPORT_EXISTS');self.set('export:'+export_id,canonical(result))
        with (folder/'export.json').open('x',encoding='utf8') as f: f.write(canonical(result))
        return result

    def verify_export(self,receipt):
        import pyarrow.parquet as pq
        demand(isinstance(receipt,dict) and isinstance(receipt.get('id'),str),'EXPORT_RECEIPT')
        saved=self.get('export:'+receipt['id']);demand(saved is not None and saved==canonical(receipt),'EXPORT_RECEIPT')
        folder=plain(receipt['directory']);demand((folder/'export.json').read_text(encoding='utf8')==saved,'EXPORT_MANIFEST_CHANGED')
        cursor=0
        for part in receipt['files']:
            file=plain(folder/part['path']);demand(file.parent==folder and file.is_file() and filehash(file)==part['sha256'],'EXPORT_FILE_CHANGED')
            with file.open('rb') as f:rows=pq.read_table(f).to_pylist()
            demand(len(rows)==part['rows'] and len(rows)<=500,'EXPORT_COUNT')
            for row in rows:
                cursor+=1;demand(row['seq']==cursor and digest(row['payload'])==row['row_hash'],'EXPORT_ROW_CHANGED')
        file=plain(folder/receipt['catalogFile']);demand(file.parent==folder and file.is_file() and filehash(file)==receipt['catalogSha256'],'EXPORT_CATALOG_CHANGED')
        with file.open('rb') as f:catalog=pq.read_table(f).to_pylist()
        demand(cursor==receipt['records'] and all(r['generation']==receipt['generation'] and r['catalog_token']==receipt['catalogToken'] and r['cut']==cursor for r in catalog),'EXPORT_CUT_CHANGED')
        return dict(status='VERIFIED',records=cursor,files=receipt['files'],catalogFile=receipt['catalogFile'],directory=str(folder))
