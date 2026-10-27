"""F36: rebuildable record projection, bounded deltas, real Parquet and PG.
Canonical originals remain outside this projection. No arbitrary SQL or paths
are accepted by the HTTP-facing contract. Every returned record is verified
against its original again by volume.mjs.
"""
import base64,contextlib,hashlib,hmac,json,os,pathlib,secrets,sqlite3,sys,uuid
# Shared application-owned import root, also when launched outside this directory.
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent.parent/'agent-forensic-handoff'/'python'))
from afh_semantic.path_safety import plain_path,PathSafetyError

class VolumeError(Exception):pass
def demand(ok,code):
 if not ok:raise VolumeError('VOLUME_'+code)
def canonical(value):return json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':'))
def digest(value):return hashlib.sha256(value if isinstance(value,bytes) else value.encode('utf8')).hexdigest()
def filehash(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  while b:=f.read(1024*1024):h.update(b)
 return h.hexdigest()
def plain(p):
 try:return plain_path(p)
 except PathSafetyError as error:raise VolumeError('VOLUME_'+str(error)) from error

def crash(point):
 if os.environ.get('AFH_VOLUME_CRASH_AT')==point:os._exit(86)

class Store:
 def __init__(self,root):
  self.root=plain(root);self.path=plain(self.root/'volume');self.path.mkdir(exist_ok=True,parents=True)
  for suffix in ['', '-wal','-shm']:plain(self.path/('operational.sqlite'+suffix))
  self.db=sqlite3.connect(self.path/'operational.sqlite',timeout=10,isolation_level=None);self.db.row_factory=sqlite3.Row
  self.db.executescript('''PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
   CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,case_hash TEXT NOT NULL,manifest_hash TEXT NOT NULL,after_ref INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 0,records INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS records(seq INTEGER PRIMARY KEY,source_id TEXT NOT NULL,uri TEXT NOT NULL,kind TEXT NOT NULL,raw TEXT NOT NULL,payload TEXT NOT NULL,row_hash TEXT NOT NULL,UNIQUE(source_id,uri));
   CREATE INDEX IF NOT EXISTS volume_source_sequence ON records(source_id,seq);
   CREATE INDEX IF NOT EXISTS volume_kind_sequence ON records(kind,seq);
   CREATE TABLE IF NOT EXISTS parts(lo INTEGER PRIMARY KEY,hi INTEGER NOT NULL,n INTEGER NOT NULL,path TEXT NOT NULL,sha TEXT NOT NULL,bytes INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS heads(gen TEXT PRIMARY KEY,token TEXT NOT NULL,cut INTEGER NOT NULL,path TEXT NOT NULL,sha TEXT NOT NULL,n INTEGER NOT NULL);
  ''')
  with self.tx():
   if not self.get('instance'):
    for k,v in {'instance':str(uuid.uuid4()),'secret':secrets.token_hex(32),'schema':'1','catalog':'','token':'','generation':'','lake_cursor':'0'}.items():self.set(k,v)
   demand(self.get('schema')=='1','SCHEMA')
 def close(self):self.db.close()
 @contextlib.contextmanager
 def tx(self):
  self.db.execute('BEGIN IMMEDIATE')
  try:yield;self.db.execute('COMMIT')
  except BaseException:self.db.execute('ROLLBACK');raise
 def get(self,k):
  r=self.db.execute('SELECT v FROM meta WHERE k=?',(k,)).fetchone();return r[0] if r else None
 def set(self,k,v):self.db.execute('INSERT INTO meta VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v',(k,str(v)))
 def catalog(self):return json.loads(self.get('catalog')) if self.get('catalog') else []
 def prepare(self,catalog):
  sources=catalog['sources'];demand(isinstance(sources,list) and len(sources)<=10000,'CATALOG_LIMIT')
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
 def status(self):
  pending=[];expected=0
  for s in self.catalog():
   row=self.db.execute('SELECT * FROM sources WHERE id=?',(s['id'],)).fetchone();expected+=row['records']
   if not row['complete']:pending.append({'id':s['id'],'after':row['after_ref']})
  high=self.db.execute('SELECT COALESCE(MAX(seq),0) FROM records').fetchone()[0];lc=int(self.get('lake_cursor'))
  head=self.db.execute('SELECT cut FROM heads WHERE gen=?',(self.get('generation'),)).fetchone()
  return dict(schema='orbita-volume-1',instance=self.get('instance'),generation=self.get('generation'),catalogToken=self.get('token'),ready=bool(self.get('token')) and not pending,pending=pending,records=expected,storedRecords=self.db.execute('SELECT COUNT(*) FROM records').fetchone()[0],high=high,sources=len(self.catalog()),lake=dict(cursor=lc,parts=self.db.execute('SELECT COUNT(*) FROM parts').fetchone()[0],pendingRecords=high-lc,ready=bool(head and head[0]==high and lc==high),verification='requires_explicit_verification'),semantics='Original historical records; no truth, current applicability or execution authority established')
 def append(self,source,expected_after,after,rows,complete):
  demand(type(after)==int and type(expected_after)==int and after>=expected_after and len(rows)<=500 and type(complete)==bool,'BATCH_INPUT')
  demand(sum(len(canonical(r).encode()) for r in rows)<=8*1024**2,'BATCH_BYTES')
  demand(source in [s['id'] for s in self.catalog()],'SOURCE_NOT_SELECTED')
  with self.tx():
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
  except Exception:raise VolumeError('VOLUME_CURSOR')
 def query(self,request,backend='sqlite'):
  state=self.status();demand(state['ready'],'PROJECTION_PENDING')
  selected=sorted(request.get('sourceIds') or [s['id'] for s in self.catalog()]);demand(len(selected)==len(set(selected)) and set(selected)<=set(s['id'] for s in self.catalog()),'SELECTION')
  limit=request.get('limit',200);q=request.get('query','');demand(type(limit)==int and 1<=limit<=200 and isinstance(q,str) and len(q)<=500,'QUERY_LIMIT')
  binding=dict(instance=state['instance'],generation=state['generation'],token=state['catalogToken'],selection=selected,query=q,backend=backend)
  after=0;high=state['high']
  if request.get('cursor'):
   token=self.decode(request['cursor']);demand(token.get('binding')==binding,'CURSOR_STALE');after=token.get('after');high=token.get('high');demand(type(after)==int and type(high)==int and 0<=after<=high<=state['high'],'CURSOR')
  if not selected:return dict(rows=[],cursor=None,high=high,generation=state['generation'],catalogToken=state['catalogToken'],backend=backend,bytes=0,completePage=True,more=False,applicability='not_established',executionAuthority=False)
  placeholders=','.join('?' for _ in selected)
  expected=sum(self.db.execute('SELECT records FROM sources WHERE id=?',(s,)).fetchone()[0] for s in selected)
  actual=self.db.execute(f'SELECT COUNT(*) FROM records WHERE source_id IN ({placeholders})',selected).fetchone()[0];demand(actual==expected,'ROW_COUNT_CHANGED')
  rows=[];size=0;more=False
  with contextlib.ExitStack() as stack:
   if backend=='sqlite':
    self.db.execute('BEGIN');stack.callback(lambda:self.db.execute('ROLLBACK'))
    metadata=self.db.execute(f'SELECT seq,length(CAST(payload AS BLOB)) FROM records WHERE seq>? AND seq<=? AND source_id IN ({placeholders}) AND instr(raw,?)>0 ORDER BY seq LIMIT ?', [after,high,*selected,q,limit+1]).fetchall()
   elif backend=='postgres':
    pg=stack.enter_context(self.pg())
    pg.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    head=pg.execute('SELECT cursor,token FROM orbita_volume_instances WHERE id=%s',(state['instance'],)).fetchone();demand(head and head[0]>=high and head[1]==state['catalogToken'],'POSTGRES_BEHIND')
    count=pg.execute('SELECT COUNT(*) FROM orbita_volume_rows WHERE instance=%s AND source_id=ANY(%s) AND seq<=%s',(state['instance'],selected,high)).fetchone()[0];demand(count==expected,'POSTGRES_COUNT_CHANGED')
    metadata=pg.execute('SELECT seq,octet_length(payload) FROM orbita_volume_rows WHERE instance=%s AND seq>%s AND seq<=%s AND source_id=ANY(%s) AND strpos(raw,%s)>0 ORDER BY seq LIMIT %s',(state['instance'],after,high,selected,q,limit+1)).fetchall()
   else:raise VolumeError('VOLUME_BACKEND')
   # Fetch only small metadata first, then one byte-bounded payload batch.
   # This avoids both an unbounded client buffer and one network trip per row.
   wanted=[];estimated=0;budget=2*1024**2;single_large=False
   for seq,n in metadata[:limit]:
    demand(n<=8*1024**2,'RECORD_EXCEEDS_RESPONSE_BUDGET')
    if n+200>budget:
     if wanted:break
     # The ingestion contract admits intact records up to 8 MiB. Return a
     # large one alone, with an explicit envelope, never drop or truncate it.
     budget=8*1024**2+512;single_large=True
    if estimated+n+200>budget:break
    wanted.append(seq);estimated+=n+200
    if single_large:break
   more=len(metadata)>len(wanted)
   if not wanted:found=[]
   elif backend=='sqlite':
    found=self.db.execute('SELECT seq,payload,row_hash FROM records WHERE seq IN ('+','.join('?' for _ in wanted)+') ORDER BY seq',wanted).fetchall()
   else:found=pg.execute('SELECT seq,payload,row_hash FROM orbita_volume_rows WHERE instance=%s AND seq=ANY(%s) ORDER BY seq',(state['instance'],wanted)).fetchall()
   demand([r[0] for r in found]==wanted,'PAGE_CHANGED')
   for seq,payload,h in found:
    demand(digest(payload)==h,'ROW_HASH_CHANGED');value=json.loads(payload);demand(digest(value['raw'])==value['sha'],'RAW_HASH_CHANGED');value.update(seq=seq,rowHash=h)
    n=len(canonical(value).encode());demand(size+n<=budget,'RESPONSE_BUDGET');rows.append(value);size+=n

  cursor=self.sign(dict(binding=binding,high=high,after=rows[-1]['seq'])) if more and rows else None
  return dict(rows=rows,cursor=cursor,high=high,generation=state['generation'],catalogToken=state['catalogToken'],backend=backend,bytes=size,responseBudgetBytes=budget,singleLargeRecord=single_large,completePage=True,more=bool(cursor),applicability='not_established',executionAuthority=False)
 def pg(self):
  file=plain(os.environ.get('AFH_VOLUME_PG_CONFIG','__missing_volume_pg_config__'));demand(file.is_file(),'POSTGRES_NOT_CONFIGURED');demand(not file.is_relative_to(self.root),'POSTGRES_CONFIG_INSIDE_DATA')
  config=json.loads(file.read_text(encoding='utf8'));allowed=[str(pathlib.Path(x).resolve()).casefold() for x in config.pop('allowedRoots',[])]
  demand(str(self.root.resolve()).casefold() in allowed,'POSTGRES_ROOT_NOT_AUTHORIZED');demand(config.get('host') in ['127.0.0.1','localhost'] and type(config.get('port'))==int,'POSTGRES_LOOPBACK_ONLY')
  import psycopg
  return psycopg.connect(**config,connect_timeout=5)
 def mirror(self,limit=500):
  state=self.status();demand(state['ready'],'PROJECTION_PENDING');demand(type(limit)==int and 1<=limit<=500,'BATCH_LIMIT')
  with self.pg() as pg:
   pg.execute('CREATE TABLE IF NOT EXISTS orbita_volume_instances(id TEXT PRIMARY KEY,cursor BIGINT NOT NULL,token TEXT NOT NULL)')
   pg.execute('CREATE TABLE IF NOT EXISTS orbita_volume_rows(instance TEXT NOT NULL,seq BIGINT NOT NULL,source_id TEXT NOT NULL,raw TEXT NOT NULL,payload TEXT NOT NULL,row_hash TEXT NOT NULL,PRIMARY KEY(instance,seq))')
   pg.execute('CREATE INDEX IF NOT EXISTS orbita_volume_source ON orbita_volume_rows(instance,source_id,seq)')
   pg.execute("INSERT INTO orbita_volume_instances VALUES(%s,0,'') ON CONFLICT DO NOTHING",(state['instance'],))
   cursor=pg.execute('SELECT cursor FROM orbita_volume_instances WHERE id=%s FOR UPDATE',(state['instance'],)).fetchone()[0];demand(cursor<=state['high'],'POSTGRES_AHEAD')
   rows=[];total=0
   for row in self.db.execute('SELECT seq,source_id,raw,payload,row_hash FROM records WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?',(cursor,state['high'],limit)):
    n=len(row['payload'].encode());demand(n<=8*1024**2,'RECORD_TOO_LARGE')
    if rows and total+n>8*1024**2:break
    rows.append(row);total+=n
   if rows:
    for i,row in enumerate(rows):demand(digest(row['payload'])==row['row_hash'] and row['seq']==cursor+i+1,'ROW_HASH_OR_DELTA_CHANGED')
    with pg.cursor() as cur:cur.executemany('INSERT INTO orbita_volume_rows VALUES(%s,%s,%s,%s,%s,%s)',[(state['instance'],*tuple(row)) for row in rows])
    got=pg.execute('SELECT seq,source_id,raw,payload,row_hash FROM orbita_volume_rows WHERE instance=%s AND seq>%s AND seq<=%s ORDER BY seq',(state['instance'],cursor,rows[-1]['seq'])).fetchall();demand(got==[tuple(r) for r in rows],'POSTGRES_READBACK')
    cursor=rows[-1]['seq']
   pg.execute('UPDATE orbita_volume_instances SET cursor=%s,token=%s WHERE id=%s',(cursor,state['catalogToken'] if cursor==state['high'] else '',state['instance']));crash('postgres-before-commit')
  result=dict(backend='postgres',cursor=cursor,cut=state['high'],added=len(rows),ready=cursor==state['high'],readbackVerified=True)
  with self.tx():self.set('postgres_receipt',canonical(result))
  return result
 def parquet_write(self,prefix,rows):
  import pyarrow as pa
  import pyarrow.parquet as pq
  folder=plain(self.path/'lake');folder.mkdir(exist_ok=True);name=prefix+'-'+str(uuid.uuid4())+'.parquet';final=plain(folder/name);temp=plain(folder/(name+'.partial'))
  with temp.open('xb') as f:
   pq.write_table(pa.Table.from_pylist(rows),f,compression='zstd',row_group_size=500);f.flush();os.fsync(f.fileno())
  with temp.open('rb') as f:demand(pq.read_table(f).to_pylist()==rows,'PARQUET_READBACK')
  os.link(temp,final);temp.unlink();return final,filehash(final)
 def lake(self,limit=500):
  demand(type(limit)==int and 1<=limit<=500,'BATCH_LIMIT');state=self.status();demand(state['ready'],'PROJECTION_PENDING')
  with self.tx():
   cursor=int(self.get('lake_cursor'));rows=self.db.execute('SELECT seq,source_id,kind,payload,row_hash FROM records WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?',(cursor,state['high'],limit))
   values=[];total=0
   for r in rows:
    demand(digest(r['payload'])==r['row_hash'],'ROW_HASH_CHANGED');n=len(r['payload'].encode());demand(n<=8*1024**2,'RECORD_TOO_LARGE')
    if values and total+n>8*1024**2:break
    values.append(dict(r));total+=n
   if values:
    demand(values[0]['seq']==cursor+1 and values[-1]['seq']-cursor==len(values),'DELTA_GAP')
    file,h=self.parquet_write(f'part-{cursor+1}-{values[-1]["seq"]}',values);crash('lake-after-file')
    self.db.execute('INSERT INTO parts VALUES(?,?,?,?,?,?)',(cursor+1,values[-1]['seq'],len(values),file.name,h,file.stat().st_size));cursor=values[-1]['seq'];self.set('lake_cursor',cursor);crash('lake-before-commit')
   if cursor==state['high'] and not self.db.execute('SELECT 1 FROM heads WHERE gen=?',(state['generation'],)).fetchone():
    sources=[dict(source_id=s['id'],metadata=canonical(s),generation=state['generation'],catalog_token=state['catalogToken'],cut=state['high']) for s in self.catalog()]
    # Empty catalogs have a typed metadata row, never a fabricated source.
    if not sources:sources=[dict(source_id='',metadata='null',generation=state['generation'],catalog_token=state['catalogToken'],cut=state['high'])]
    file,h=self.parquet_write('catalog',sources);self.db.execute('INSERT INTO heads VALUES(?,?,?,?,?,?)',(state['generation'],state['catalogToken'],state['high'],file.name,h,len(sources)))
  return dict(added=len(values),cursor=cursor,cut=state['high'],ready=cursor==state['high'],**{'state':self.status()})
 def verify_lake(self):
  import pyarrow.parquet as pq
  state=self.status();demand(state['ready'] and state['lake']['ready'],'LAKE_BEHIND');head=self.db.execute('SELECT * FROM heads WHERE gen=?',(state['generation'],)).fetchone();demand(head and head['token']==state['catalogToken'],'LAKE_HEAD')
  folder=plain(self.path/'lake');files=[];cursor=0;count=0;kinds={}
  for part in self.db.execute('SELECT * FROM parts WHERE hi<=? ORDER BY lo',(head['cut'],)):
   demand(part['lo']==cursor+1 and part['hi']-cursor==part['n'],'LAKE_GAP');file=plain(folder/part['path']);demand(file.parent==folder and file.is_file() and filehash(file)==part['sha'],'LAKE_FILE_CHANGED')
   with file.open('rb') as f:rows=pq.read_table(f).to_pylist()
   demand(len(rows)==part['n'],'LAKE_COUNT')
   for row in rows:
    cursor+=1;demand(row['seq']==cursor and digest(row['payload'])==row['row_hash'],'LAKE_ROW_CHANGED');saved=self.db.execute('SELECT row_hash FROM records WHERE seq=?',(cursor,)).fetchone();demand(saved and saved[0]==row['row_hash'],'LAKE_CANONICAL_PROJECTION_MISMATCH');kinds[row['kind']]=kinds.get(row['kind'],0)+1
   count+=len(rows);files.append(dict(path='lake/'+part['path'],sha256=part['sha'],rows=part['n']))
  demand(cursor==head['cut'] and count==head['cut'],'LAKE_INCOMPLETE');file=plain(folder/head['path']);demand(file.parent==folder and file.is_file() and filehash(file)==head['sha'],'LAKE_CATALOG_CHANGED')
  with file.open('rb') as f:metadata=pq.read_table(f).to_pylist()
  restored=[json.loads(x['metadata']) for x in metadata if x['source_id']];demand(restored==self.catalog(),'LAKE_CATALOG_BINDING')
  return dict(status='VERIFIED',records=count,currentSources=state['sources'],catalogToken=state['catalogToken'],generation=state['generation'],cut=cursor,kinds=kinds,files=files,catalogFile='lake/'+head['path'],catalogSha256=head['sha'],scope='Historical original-record projection including retained superseded sources; not current factual validity')

def main():
 request=json.load(sys.stdin);store=Store(request['root'])
 try:
  op=request['op']
  if op=='prepare':result=store.prepare(request['catalog'])
  elif op=='append':result=store.append(request['source'],request['expectedAfter'],request['after'],request['rows'],request['complete'])
  elif op=='status':result=store.status()
  elif op=='page':result=store.query(request,request.get('backend','sqlite'))
  elif op=='lake':result=store.lake(request.get('limit',500))
  elif op=='verify':result=store.verify_lake()
  elif op=='postgres':result=store.mirror(request.get('limit',500))
  else:raise VolumeError('VOLUME_OPERATION')
  sys.stdout.write(json.dumps(result,ensure_ascii=False,separators=(',',':')))
 finally:store.close()

if __name__=='__main__':
 try:main()
 except Exception as e:
  # Provider/driver errors may include connection details. Never print them.
  sys.stdout.write(json.dumps({'error':str(e) if isinstance(e,VolumeError) else 'VOLUME_DEPENDENCY_OR_STORAGE_ERROR'}));sys.exit(1)
