"""Explicit, root-bound PostgreSQL storage for the existing semantic contracts.

SQLite stays the default. No connection is inferred from a copied data directory.
The compatibility surface is deliberately small: application SQL, not user SQL.
Original evidence, approval and support validators are still owned by N04/F22.
"""
import hashlib, json, os, re, sqlite3, uuid
from pathlib import Path
from .path_safety import plain_path,PathSafetyError

FOLDERS = ('', 'collectives', 'decisions', 'supports', 'identities', 'retrospectives', 'intelligence', 'causal', 'learning')
MARKER = 'postgres-storage.json'

def require(ok, code):
    if not ok: raise ValueError('SEMANTIC_PG_' + code)

def canonical(value): return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
def digest(value): return hashlib.sha256(canonical(value).encode()).hexdigest()
def normalized(path): return str(Path(path).resolve()).casefold()

def plain(path):
    try:return plain_path(path).resolve()
    except PathSafetyError as error:raise ValueError('SEMANTIC_PG_'+str(error)) from error


def atomic_json(path, value):
    path = Path(path); temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temp.open('x', encoding='utf8') as f:
        f.write(canonical(value)); f.flush(); os.fsync(f.fileno())
    os.replace(temp, path)

def read_config():
    name = os.environ.get('AFH_SEMANTIC_PG_CONFIG')
    if not name: return None
    try: cfg = json.loads(plain(name).read_text(encoding='utf8'))
    except Exception: raise ValueError('SEMANTIC_PG_CONFIG_UNAVAILABLE') from None
    require(cfg.get('schema') == 1 and isinstance(cfg.get('roots'), dict), 'CONFIG_SCHEMA')
    require(cfg.get('host') in ('127.0.0.1', '::1', 'localhost'), 'LOCAL_HOST_REQUIRED')
    require(type(cfg.get('port')) is int and 1 <= cfg['port'] <= 65535, 'PORT')
    for field in ('dbname','user','password'): require(isinstance(cfg.get(field), str) and bool(cfg[field]), 'CONFIG_FIELD')
    return cfg

def binding(path, *, force=False):
    path = plain(path)
    for parent in (path.parent, *path.parents):
        if parent.name != 'semantic': continue
        root = parent.parent; marker = parent / MARKER
        # Recovery authority lives outside content and is never copied from it.
        receipt = root.parent / ('.' + root.name + '.orbita-restore.json')
        paused = receipt.exists() and json.loads(receipt.read_text(encoding='utf8')).get('externalAccess') is not True
        if paused:
            if marker.exists(): require(json.loads(marker.read_text(encoding='utf8')).get('exportComplete') is True, 'RESTORE_SNAPSHOT_MISSING')
            if force: raise ValueError('SEMANTIC_PG_EXTERNAL_ACCESS_PAUSED')
            return None
        cfg = read_config()
        entry = next((v for k,v in (cfg or {}).get('roots', {}).items() if normalized(k) == normalized(root)), None)
        if entry and (entry.get('active') is True or force):
            require(os.environ.get('AFH_MANAGED') != '1', 'MANAGED_NOT_ADMITTED')
            require(re.fullmatch('[a-f0-9]{32}', entry.get('namespace', '')), 'NAMESPACE')
            relative = path.relative_to(parent).as_posix()
            require(path.name in ('records.sqlite3', 'corpus.sqlite3') and relative in {f'{f+"/" if f else ""}{n}' for f in FOLDERS for n in ('records.sqlite3','corpus.sqlite3')}, 'STORE_PATH')
            if marker.exists(): require(json.loads(marker.read_text(encoding='utf8'))['namespace'] == entry['namespace'], 'ROOT_REBOUND')
            return dict(cfg=cfg, root=root, namespace=entry['namespace'], relative=relative, schema='s_' + digest([entry['namespace'], relative])[:40])
        if marker.exists(): raise ValueError('SEMANTIC_PG_CONNECTION_NOT_ADMITTED')
        return None
    return None

def key(namespace): return int(hashlib.sha256(namespace.encode()).hexdigest()[:15], 16)

def adapt_json(statement):
    # These application-owned paths return strings; retain NULL for absent keys.
    return re.sub(r"json_extract\((\w+),'\$\.([\w.]+)'\)",lambda m:"("+m[1]+"::jsonb #>> '{"+m[2].replace('.',',')+"}')",statement)

def raw_connect(cfg):
    try:
        import psycopg
        return psycopg.connect(**{k:cfg[k] for k in ('host','port','dbname','user','password')}, autocommit=True, connect_timeout=5)
    except Exception: raise ValueError('SEMANTIC_PG_UNAVAILABLE') from None

class Row(dict):
    def __getitem__(self, item): return list(self.values())[item] if isinstance(item, int) else super().__getitem__(item)

class Cursor:
    def __init__(self, cursor, star=False): self.cursor=cursor; self.star=star
    def row(self, row):
        if row is None: return None
        return Row((d.name,v) for d,v in zip(self.cursor.description,row) if not (self.star and d.name in ('rowid','source_ids')))
    def fetchone(self): return self.row(self.cursor.fetchone())
    def fetchall(self): return [self.row(r) for r in self.cursor.fetchall()]
    def fetchmany(self, size=1000): return [self.row(r) for r in self.cursor.fetchmany(size)]
    def __iter__(self):
        for row in self.cursor: yield self.row(row)
    @property
    def rowcount(self): return self.cursor.rowcount

def statements(script):
    current=''
    for char in script:
        current+=char
        if char==';' and sqlite3.complete_statement(current):
            yield current.strip().rstrip(';'); current=''
    if current.strip(): yield current.strip().rstrip(';')

class Connection:
    postgres=True
    def __init__(self, path, bound, *, read_only=False, lock=True):
        self.path=Path(path); self.bound=bound; self.schema=bound['schema']; self.read_only=read_only; self.row_factory=None
        self.raw=raw_connect(bound['cfg']); self.columns={}; self.depth=0; self.restricted=False; self.integrity_batch=None
        try:
            self.raw.execute("SET statement_timeout='55s'"); self.raw.execute("SET lock_timeout='20s'")
            if lock: self.raw.execute('SELECT pg_advisory_lock_shared(%s)',(key(bound['namespace']),))
            if not read_only:
                self.raw.execute(f'CREATE SCHEMA IF NOT EXISTS {self.schema}')
            self.raw.execute(f'SET search_path TO {self.schema},public')
            if not read_only: self.initialize()
            else: require(self.raw.execute("SELECT to_regclass(%s)",(self.schema+'.orbita_ddl',)).fetchone()[0] is not None,'STORE_NOT_MIGRATED')
        except BaseException: self.raw.close(); raise

    def initialize(self):
        self.raw.execute('CREATE TABLE IF NOT EXISTS orbita_ddl(name TEXT PRIMARY KEY,type TEXT NOT NULL,sql TEXT NOT NULL)')
        self.raw.execute('CREATE TABLE IF NOT EXISTS orbita_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision BIGINT NOT NULL)')
        self.raw.execute('INSERT INTO orbita_revision VALUES(1,0) ON CONFLICT DO NOTHING')
        self.raw.execute('CREATE OR REPLACE VIEW sqlite_master AS SELECT name,type,sql FROM orbita_ddl')
        self.raw.execute("""CREATE OR REPLACE FUNCTION orbita_no_change() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'append only'; END $$""")
        self.raw.execute("""CREATE OR REPLACE FUNCTION orbita_changed() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN UPDATE orbita_revision SET revision=revision+1 WHERE id=1; RETURN NULL; END $$""")

    def cols(self, table):
        if table not in self.columns:
            self.columns[table]=[r[0] for r in self.raw.execute("SELECT column_name FROM information_schema.columns WHERE table_schema=%s AND table_name=%s AND is_generated='NEVER' ORDER BY ordinal_position",(self.schema,table)) if r[0]!='rowid']
        require(bool(self.columns[table]),'UNKNOWN_TABLE')
        return self.columns[table]

    def save_ddl(self, name, kind, statement):
        self.raw.execute('INSERT INTO orbita_ddl VALUES(%s,%s,%s) ON CONFLICT DO NOTHING',(name,kind,statement))

    def ddl(self, statement):
        require(not self.read_only,'READ_ONLY')
        match=re.match(r'CREATE (VIRTUAL )?TABLE IF NOT EXISTS (\w+)',statement,re.I)
        if match:
            table=match[2]; existing=self.raw.execute("SELECT 1 FROM orbita_ddl WHERE name=%s",(table,)).fetchone()
            if existing: return
            if match[1]:
                require(table=='afh_publication_fts','VIRTUAL_TABLE_UNSUPPORTED')
                sql=f'CREATE TABLE {table}(outbox_id TEXT,text TEXT,rowid BIGSERIAL UNIQUE)'
            else:
                sql=re.sub(r'INTEGER\s+PRIMARY\s+KEY', 'BIGSERIAL PRIMARY KEY',statement,flags=re.I)
                sql=re.sub(r'\bINTEGER\b','BIGINT',sql,flags=re.I)
                sql=re.sub(r'\bREAL\b','DOUBLE PRECISION',sql,flags=re.I)
                end=sql.rfind(')'); sql=sql[:end]+', rowid BIGSERIAL UNIQUE'+sql[end:]
            self.raw.execute(sql); self.save_ddl(table,'table',statement)
            if table in ('record_versions','semantic_support_admissions'):
                self.raw.execute(f'CREATE TRIGGER orbita_revision_trigger AFTER INSERT OR UPDATE OR DELETE ON {table} FOR EACH STATEMENT EXECUTE FUNCTION orbita_changed()')
            if table=='record_versions': self.install_source_index()
            return
        match=re.match(r'CREATE TRIGGER IF NOT EXISTS (\w+) BEFORE (UPDATE|DELETE) ON (\w+)\s+BEGIN SELECT RAISE\(ABORT,\s*\'append only\'\); END',statement,re.I)
        if match:
            name,event,table=match.groups()
            if not self.raw.execute('SELECT 1 FROM orbita_ddl WHERE name=%s',(name,)).fetchone():
                self.raw.execute(f'CREATE TRIGGER {name} BEFORE {event} ON {table} FOR EACH ROW EXECUTE FUNCTION orbita_no_change()'); self.save_ddl(name,'trigger',statement)
            return
        match=re.match(r'CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)',statement,re.I)
        if match: self.raw.execute(adapt_json(statement)); self.save_ddl(match[1],'index',statement); return
        raise ValueError('SEMANTIC_PG_DDL_UNSUPPORTED')

    def install_source_index(self):
        # Generated by the storage engine from the canonical payload in the same
        # transaction. No independently mutable sidecar can silently omit a source.
        self.raw.execute("""CREATE OR REPLACE FUNCTION orbita_source_ids(payload TEXT) RETURNS TEXT[]
            LANGUAGE SQL IMMUTABLE STRICT AS $$ SELECT COALESCE(array_agg(ref->>'id'),ARRAY[]::TEXT[])
            FROM jsonb_array_elements(payload::jsonb->'source_refs') ref $$""")
        self.raw.execute('ALTER TABLE record_versions ADD COLUMN source_ids TEXT[] GENERATED ALWAYS AS (orbita_source_ids(payload)) STORED')
        self.raw.execute('CREATE INDEX orbita_record_sources ON record_versions USING GIN(source_ids)')

    def restrict_sources(self, sources):
        """All versions of any record touching selection, including corrections.
        Never filter individual versions: that could resurrect a superseded head.
        """
        require(not self.restricted,'ALREADY_RESTRICTED')
        from psycopg import sql
        value=sql.SQL('CREATE TEMP VIEW record_versions AS SELECT r.* FROM {}.record_versions r WHERE r.record_id IN (SELECT record_id FROM {}.record_versions WHERE source_ids && {}::TEXT[])').format(sql.Identifier(self.schema),sql.Identifier(self.schema),sql.Literal(list(sources)))
        self.raw.execute(value); self.restricted=True

    def prefetch_integrity(self, rows):
        from .integrity_batch import IntegrityBatch
        self.integrity_batch=IntegrityBatch.build(self,rows)

    def execute(self, statement, parameters=()):
        statement=statement.strip().rstrip(';')
        if statement.upper().startswith('CREATE '): self.ddl(statement); return Cursor(self.raw.execute('SELECT 1 WHERE FALSE'))
        if statement.upper()=='PRAGMA QUERY_ONLY=ON': self.read_only=True; return Cursor(self.raw.execute('SELECT 1 WHERE FALSE'))
        if statement.upper() in ('BEGIN','BEGIN IMMEDIATE','COMMIT','ROLLBACK'): self.integrity_batch=None
        if statement.upper() in ('BEGIN','BEGIN IMMEDIATE'):
            self.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ' if self.read_only else 'BEGIN')
            if statement.upper()=='BEGIN IMMEDIATE': self.raw.execute('SELECT pg_advisory_xact_lock(%s)',(key(self.schema),))
            return Cursor(self.raw.execute('SELECT 1 WHERE FALSE'))
        require(not self.read_only or statement.upper().startswith(('SELECT','WITH','ROLLBACK','COMMIT')), 'READ_ONLY')
        if self.integrity_batch is not None and self.read_only and int(self.raw.info.transaction_status)==2:
            cached=self.integrity_batch.lookup(statement,parameters)
            if cached is not None:
                from .integrity_batch import BufferedCursor
                return BufferedCursor(cached,Row)
        original=statement
        if statement.upper().startswith('INSERT OR IGNORE INTO RECORD_INTEGRITY_POLICY') and self.raw.execute('SELECT 1 FROM record_integrity_policy WHERE singleton=1').fetchone():
            return Cursor(self.raw.execute('SELECT 1 WHERE FALSE'))
        ignored=bool(re.match(r'INSERT OR IGNORE',statement,re.I)); statement=re.sub(r'^INSERT OR IGNORE','INSERT',statement,flags=re.I)
        match=re.match(r'INSERT INTO (\w+)\s+VALUES',statement,re.I)
        if match: statement=statement[:match.end()-6]+'('+','.join(self.cols(match[1]))+') VALUES'+statement[match.end():]
        match=re.match(r'INSERT INTO (\w+)\s+SELECT',statement,re.I)
        if match: statement=statement[:match.end()-6]+'('+','.join(self.cols(match[1]))+') SELECT'+statement[match.end():]
        if ignored: statement+=' ON CONFLICT DO NOTHING'
        statement=adapt_json(statement)
        if 'afh_publication_fts MATCH ?' in statement:
            # unicode61 is part of F16's contract. PostgreSQL's simple/unaccent
            # tokenizer is not equivalent (underscores, punctuation, accents).
            # Rebuild this bounded derived index from authoritative remote rows;
            # never silently change search semantics or read a stale local copy.
            rows=self.raw.execute('SELECT outbox_id,text FROM afh_publication_fts LIMIT 5001').fetchall()
            require(len(rows)<=5000,'PUBLICATION_QUERY_BOUND')
            with sqlite3.connect(':memory:') as search:
                search.execute('CREATE VIRTUAL TABLE fts USING fts5(outbox_id UNINDEXED,text)')
                search.executemany('INSERT INTO fts VALUES(?,?)',rows)
                matches=[r[0] for r in search.execute('SELECT outbox_id FROM fts WHERE fts MATCH ?',(parameters[0],))]
            statement=statement.replace('afh_publication_fts MATCH ?','f.outbox_id = ANY(?)')
            parameters=(matches,*parameters[1:])
        # All caller SQL uses positional ? placeholders; literals in this surface do not.
        statement=statement.replace('%','%%').replace('?', '%s') if parameters else statement
        try: return Cursor(self.raw.execute(statement,parameters or None),star=bool(re.search(r'(?:\b\w+\.)?\*',original)))
        except Exception as error:
            if error.__class__.__module__.startswith('psycopg'):
                code=getattr(error,'sqlstate',None)
                if code=='P0001': raise sqlite3.IntegrityError('append only') from None
                if code and code.startswith('23'): raise sqlite3.IntegrityError('SEMANTIC_PG_CONSTRAINT_'+code) from None
            raise

    def executescript(self, script):
        self.commit()
        for statement in statements(script): self.execute(statement)
    def executemany(self, sql, values):
        for value in values: self.execute(sql,value)
    def commit(self):
        self.integrity_batch=None
        if self.raw.info.transaction_status:self.raw.execute('COMMIT')
    def rollback(self):
        self.integrity_batch=None
        if self.raw.info.transaction_status:self.raw.execute('ROLLBACK')
    def close(self): self.raw.close()
    @property
    def in_transaction(self): return bool(self.raw.info.transaction_status)
    def __enter__(self):
        if not self.in_transaction: self.execute('BEGIN IMMEDIATE')
        return self
    def __exit__(self, kind, value, trace): self.rollback() if kind else self.commit()

def connect(path, *, read_only=False):
    bound=binding(path)
    if bound:
        if not read_only:
            Path(path).parent.mkdir(parents=True,exist_ok=True)
            # Presence marker only; a verified export replaces it before backup.
            if not Path(path).exists(): sqlite3.connect(path).close()
        return Connection(path,bound,read_only=read_only)
    return sqlite3.connect(Path(path).resolve().as_uri()+('?mode=ro' if read_only else '?mode=rwc'),uri=True,timeout=20)

def restrict_sources(records):
    if getattr(records.db,'postgres',False):
        # Retain the complete legacy diagnostic behavior for bounded stores.
        if len(records.db.execute('SELECT record_id FROM record_versions LIMIT 5001').fetchall())<=5000:return
        records.selection_restricted=True;records.db.restrict_sources(records.memory.sources);return
    # Portable recovery can use the same selected lineage without a remote
    # service. The read-only file remains read-only while TEMP work is allowed.
    if not any((p/MARKER).exists() for p in records.path.parents if p.name=='semantic'):return
    if len(records.db.execute('SELECT record_id FROM record_versions LIMIT 5001').fetchall())<=5000:return
    records.selection_restricted=True
    db=records.db;db.execute('PRAGMA query_only=OFF')
    try:
        db.execute('CREATE TEMP TABLE orbita_selected_records(record_id TEXT PRIMARY KEY) WITHOUT ROWID')
        selected=canonical(list(records.memory.sources))
        db.execute("INSERT INTO orbita_selected_records SELECT record_id FROM main.record_versions WHERE json_extract(payload,'$.source_refs[0].id') IN (SELECT value FROM json_each(?)) UNION SELECT r.record_id FROM main.record_versions r,json_each(r.payload,'$.source_refs') ref WHERE json_array_length(r.payload,'$.source_refs')>1 AND json_extract(ref.value,'$.id') IN (SELECT value FROM json_each(?))",(selected,selected))
        db.execute('CREATE TEMP VIEW record_versions AS SELECT r.rowid,r.* FROM main.record_versions r JOIN orbita_selected_records s USING(record_id)')
        db.commit()
    finally:db.execute('PRAGMA query_only=ON')

def state(root):
    root=plain(root); stores=[];restored=False
    marker=root/'semantic'/MARKER
    if not marker.exists():return None
    marker_value=json.loads(marker.read_text(encoding='utf8'));namespace=marker_value['namespace']
    for folder in FOLDERS:
        path=root/'semantic'/folder/'records.sqlite3'
        if not path.exists(): continue
        bound=binding(path)
        if not bound:
            restored=True;local=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)
            try:
                meta=local.execute("SELECT 1 FROM sqlite_master WHERE name='orbita_export_revision'").fetchone()
                if meta: revision=local.execute('SELECT revision FROM orbita_export_revision WHERE id=1').fetchone()[0]
                else:
                    # A new local family after restore has no remote predecessor.
                    revision='local-'+digest([list(r) for r in local.execute('SELECT record_id,version,payload_sha256 FROM record_versions ORDER BY record_id,version')])
                stores.append([folder,revision])
            finally:local.close()
            continue
        with_raw=Connection(path,bound,read_only=True)
        try: stores.append([folder,with_raw.raw.execute('SELECT revision FROM orbita_revision WHERE id=1').fetchone()[0]])
        finally: with_raw.close()
    # Keep pre-migration cursor fingerprints when the exact initial logical rows
    # still exist in both stores. Larger/new generations use revision witnesses.
    legacy=stores==marker_value.get('initialRevisions')
    for item in marker_value.get('migration',[]):
        if not legacy:break
        if not item['file'].endswith('/records.sqlite3'):continue
        for table in ('record_versions','semantic_support_admissions'):
            expected=next(t for t in item['tables'] if t['table']==table)
            if expected['rows']>10000:legacy=False;break
            local=sqlite3.connect((root/item['file']).as_uri()+'?mode=ro',uri=True)
            try:
                h=hashlib.sha256();n=0
                for row in local.execute(f'SELECT rowid,* FROM {table} ORDER BY rowid'):
                    h.update(canonical(list(row)).encode());h.update(b'\n');n+=1
                if dict(rows=n,sha256=h.hexdigest())!={k:expected[k] for k in ('rows','sha256')}:legacy=False
            finally:local.close()
    return dict(backend='sqlite-restored' if restored else 'postgres',restored=restored,namespace=namespace,stores=stores,fingerprint=digest(stores),legacyCompatible=legacy)
