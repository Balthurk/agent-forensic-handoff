"""Janus is a checked mirror, never source, permission or semantic authority."""
import datetime,json,os,sqlite3,threading,time,uuid
from .graph_publication import require,digest,latest,publish,selected,render,checkpoint,POLICY
from .janus_client import binding,Janus
from .knowledge_records import _json,RecordError
from .postgres_backend import plain

def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
REMOTE_POLICY={**POLICY,'backend':'janusgraph-verified-mirror','remoteBackendQualified':True,'qualificationScope':'Explicit root; two readers and bounded generation verified now'}

class Ledger:
    def __init__(self,records,admission,write=False):
        self.config=admission['identity'];self.path=plain(records.path.parent/'graph-publications'/'janus-ledger.sqlite3')
        require(write or self.path.is_file(),'G1_REMOTE_RECEIPT_MISSING');self.path.parent.mkdir(exist_ok=True)
        self.db=sqlite3.connect(self.path.as_uri()+('?mode=rwc' if write else '?mode=ro'),uri=True,timeout=5)
        if write:self.db.executescript('''CREATE TABLE IF NOT EXISTS claims(config TEXT,scope TEXT,owner TEXT,fence INTEGER,expires REAL,PRIMARY KEY(config,scope));
        CREATE TABLE IF NOT EXISTS receipts(config TEXT,generation TEXT,fence INTEGER,payload TEXT,sha TEXT,PRIMARY KEY(config,generation,fence));
        CREATE TABLE IF NOT EXISTS selectors(config TEXT,scope TEXT,generation TEXT,fence INTEGER,sha TEXT,PRIMARY KEY(config,scope));''')
        else:self.db.execute('PRAGMA query_only=ON')
    def close(self):self.db.close()
    def claim(self,scope):return Claim(self,scope)
    def receipt(self,p,current=True,optional=False):
        row=self.db.execute('SELECT generation,fence,sha FROM selectors WHERE config=? AND scope=?',(self.config,p['scope'])).fetchone() if current else None
        if current:
            if row is None and optional:return None
            require(row is not None and row[0]==p['generation'],'G1_REMOTE_SELECTOR_MISMATCH');fence=row[1]
            value=self.db.execute('SELECT payload,sha FROM receipts WHERE config=? AND generation=? AND fence=?',(self.config,p['generation'],fence)).fetchone()
        else:value=self.db.execute('SELECT payload,sha FROM receipts WHERE config=? AND generation=? ORDER BY fence DESC LIMIT 1',(self.config,p['generation'])).fetchone()
        require(value is not None,'G1_REMOTE_RECEIPT_MISSING');r=json.loads(value[0])
        require(digest(r)==value[1] and (not current or row[2]==value[1]),'G1_REMOTE_RECEIPT_CORRUPT')
        require(r['planHash']==digest(p) and r['generation']==p['generation'] and r['config']==self.config,'G1_REMOTE_RECEIPT_MISMATCH');return r
    def save(self,r,claim):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            claim.check(self.db)
            self.db.execute('INSERT INTO receipts VALUES(?,?,?,?,?)',(self.config,r['generation'],claim.fence,_json(r),digest(r)));self.db.commit()
        except BaseException:self.db.rollback();raise
    def select(self,p,r,claim):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            claim.check(self.db);old=self.db.execute('SELECT fence FROM selectors WHERE config=? AND scope=?',(self.config,p['scope'])).fetchone()
            require(old is None or old[0]<claim.fence,'G1_REMOTE_STALE_FENCE')
            stored=self.db.execute('SELECT payload,sha FROM receipts WHERE config=? AND generation=? AND fence=?',(self.config,p['generation'],claim.fence)).fetchone()
            require(stored==(_json(r),digest(r)),'G1_REMOTE_RECEIPT_CORRUPT')
            self.db.execute('INSERT INTO selectors VALUES(?,?,?,?,?) ON CONFLICT(config,scope) DO UPDATE SET generation=excluded.generation,fence=excluded.fence,sha=excluded.sha',(self.config,p['scope'],p['generation'],claim.fence,digest(r)));self.db.commit()
        except BaseException:self.db.rollback();raise

class Claim:
    def __init__(self,ledger,scope):
        self.ledger=ledger;self.scope=scope;self.owner=uuid.uuid4().hex;self.done=threading.Event();self.lost=False;self.ttl=12
        db=ledger.db;db.execute('BEGIN IMMEDIATE')
        try:
            row=db.execute('SELECT fence,expires FROM claims WHERE config=? AND scope=?',(ledger.config,scope)).fetchone()
            require(row is None or row[1]<time.time(),'G1_REMOTE_WRITER_BUSY');self.fence=(row[0] if row else 0)+1
            db.execute('INSERT INTO claims VALUES(?,?,?,?,?) ON CONFLICT(config,scope) DO UPDATE SET owner=excluded.owner,fence=excluded.fence,expires=excluded.expires',(ledger.config,scope,self.owner,self.fence,time.time()+self.ttl));db.commit()
        except BaseException:db.rollback();raise
        self.worker=threading.Thread(target=self.renew,daemon=True);self.worker.start()
    def check(self,db):
        row=db.execute('SELECT owner,fence,expires FROM claims WHERE config=? AND scope=?',(self.ledger.config,self.scope)).fetchone()
        require(not self.lost and row is not None and row[:2]==(self.owner,self.fence) and row[2]>time.time(),'G1_REMOTE_STALE_FENCE')
    def renew(self):
        db=sqlite3.connect(self.ledger.path,timeout=5)
        try:
            while not self.done.wait(2):
                with db:
                    changed=db.execute('UPDATE claims SET expires=? WHERE config=? AND scope=? AND owner=? AND fence=? AND expires>?',(time.time()+self.ttl,self.ledger.config,self.scope,self.owner,self.fence,time.time())).rowcount
                if changed!=1:self.lost=True;return
        except Exception:self.lost=True
        finally:db.close()
    def close(self):
        self.done.set();self.worker.join()
        with self.ledger.db:self.ledger.db.execute('UPDATE claims SET expires=0 WHERE config=? AND scope=? AND owner=? AND fence=?',(self.ledger.config,self.scope,self.owner,self.fence))

def capabilities(records):
    try:admitted=binding(records);return {'configured':True,'backend':'janusgraph','readers':2,'verified':False,'default':'sqlite','automaticPromotion':False,'humanAcceptance':False}
    except (RecordError,ValueError) as e:return {'configured':False,'backend':'janusgraph','reason':e.code if isinstance(e,RecordError) else 'G1_REMOTE_CONFIG_INVALID','verified':False,'default':'sqlite','automaticPromotion':False,'humanAcceptance':False}

def dispatch_remote(records,request):
    admission=binding(records);client=Janus(admission);op=request['op'];require(op in ('graph_publish','graph_query','graph_original'),'UNKNOWN_GRAPH_OPERATION')
    if op=='graph_publish':
        local=publish(records,request['outboxId'],request['scope'])
        checkpoint('janus-after-n04')
        # Cooperative N04 writers are fenced for the complete mirror selection.
        records.db.execute('BEGIN IMMEDIATE');ledger=None;claim=None
        try:
            p,r,at=selected(records,dict(scope=request['scope'],generation=local['generation'],sourceCut=local['sourceCut']))
            ledger=Ledger(records,admission,write=True);client.schema(create=True)
            previous=ledger.db.execute('SELECT generation FROM selectors WHERE config=? AND scope=?',(ledger.config,p['scope'])).fetchone()
            if previous and previous[0]==p['generation']:
                receipt=ledger.receipt(p);observed=client.verify(p);require(observed==receipt['readbackHashes'],'G1_REMOTE_READBACK_MISMATCH')
                return {**local,'backend':'janusgraph','policy':REMOTE_POLICY,'remoteReceipt':receipt,'replayed':True}
            claim=ledger.claim(p['scope']);client.write(p);checkpoint('janus-after-objects');client.verify(p,marker=False);client.marker(p);observed=client.verify(p)
            receipt={'schema':'orbita-janus-receipt-1','generation':p['generation'],'planHash':digest(p),'readbackHashes':observed,'config':admission['identity'],'fence':claim.fence,'verifiedAt':now(),'authority':'N04 and current original access; no factual approval'}
            ledger.save(receipt,claim);checkpoint('janus-after-receipt')
            require(latest(records,p['scope'])['generation_id']==p['generation'],'G1_REMOTE_GENERATION_STALE');ledger.select(p,receipt,claim);checkpoint('janus-after-selector')
            return {**local,'backend':'janusgraph','policy':REMOTE_POLICY,'remoteReceipt':receipt,'replayed':False}
        finally:
            if claim:claim.close()
            if ledger:ledger.close()
            records.db.rollback()
    records.db.execute('BEGIN');ledger=None
    try:
        p,r,at=selected(records,request);ledger=Ledger(records,admission);receipt=ledger.receipt(p,current=request.get('mode','current')=='current');client.schema();observed=client.verify(p)
        require(observed==receipt['readbackHashes'],'G1_REMOTE_READBACK_MISMATCH')
        # Payloads have been compared in full to N04 and actual structural edges on both peers.
        result=render(records,request,p,r,at,overhead=2000)
        result['policy']=REMOTE_POLICY
        result['remoteVerification']={'receipt':receipt,'readAt':now(),'historicalAvailability':'Not asserted: recorded N04 history is checked against the mirror now','automaticPromotion':False}
        if op=='graph_query':require(len(_json(result).encode())<=request.get('maxBytes',100000),'G1_PAGE_BYTE_BUDGET')
        return result
    finally:
        if ledger:ledger.close()
        records.db.rollback()
