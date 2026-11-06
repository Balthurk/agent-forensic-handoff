"""Verified semantic migration and portable, quiescent SQLite export.
Operator-only CLI: root admissions and secrets remain outside content backups.
"""
import hashlib, json, os, sqlite3, uuid, time
from pathlib import Path
from .postgres_backend import (FOLDERS, MARKER, Connection, atomic_json, binding, canonical, digest, key, normalized, plain, raw_connect, read_config, require, statements)

def exclusive(root):
    from store_access import alive
    root=plain(root);file=plain(root.parent/('.'+root.name+'.orbita-access.sqlite'));token=uuid.uuid4().hex
    with sqlite3.connect(file,timeout=5) as db:
        db.execute('CREATE TABLE IF NOT EXISTS owners(token TEXT PRIMARY KEY,pid INTEGER NOT NULL,mode TEXT NOT NULL)');db.execute('BEGIN IMMEDIATE')
        for old,pid in db.execute('SELECT token,pid FROM owners').fetchall():
            if not alive(pid):db.execute('DELETE FROM owners WHERE token=?',(old,))
        require(db.execute('SELECT COUNT(*) FROM owners').fetchone()[0]==0,'MIGRATION_STORE_BUSY')
        db.execute('INSERT INTO owners VALUES(?,?,?)',(token,os.getpid(),'exclusive'))
    def release():
        with sqlite3.connect(file,timeout=5) as db:db.execute('DELETE FROM owners WHERE token=?',(token,))
    return release

def remote_digest(target, table, quoted):
    target.raw.execute('BEGIN')
    try:
        with target.raw.cursor(name='verify_'+uuid.uuid4().hex) as cur:
            cur.execute(f'SELECT rowid,{quoted} FROM {table} ORDER BY rowid');return stream_digest(cur)
    finally:target.raw.execute('ROLLBACK')

def sqlite_ddl(db):
    rows=[dict(zip(('name','type','sql'),r)) for r in db.execute("SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name")]
    virtual={r['name'] for r in rows if r['sql'].upper().startswith('CREATE VIRTUAL')}
    return [r for r in rows if not r['name'].startswith('orbita_export_') and not any(r['name'].startswith(v+'_') for v in virtual)]

def stream_digest(rows, progress=None):
    h=hashlib.sha256();count=0
    for row in rows:
        h.update(canonical(list(row)).encode());h.update(b'\n');count+=1
        if progress and count%5000==0:progress(count)
    return dict(rows=count,sha256=h.hexdigest())

def create_schema(connection, ddls):
    import re
    for kind in ('table','index','trigger'):
        for item in ddls:
            if item['type']!=kind: continue
            sql=item['sql']
            if 'IF NOT EXISTS' not in sql.upper(): sql=re.sub(r'^(CREATE (?:VIRTUAL )?TABLE|CREATE (?:UNIQUE )?INDEX|CREATE TRIGGER)',r'\1 IF NOT EXISTS',sql,flags=re.I)
            connection.ddl(sql)

def migrate(root):
    root=plain(root);cfg=read_config();require(cfg is not None,'CONFIG_REQUIRED')
    entry=next((v for k,v in cfg['roots'].items() if normalized(k)==normalized(root)),None)
    require(entry is not None and entry.get('active') is False,'INACTIVE_ROOT_REQUIRED')
    release=exclusive(root);control=None;receipt=[]
    try:
        control=raw_connect(cfg)
        control.execute('SELECT pg_advisory_lock(%s)',(key(entry['namespace']),))
        for folder in FOLDERS:
            for name in ('corpus.sqlite3','records.sqlite3'):
                path=plain(root/'semantic'/folder/name)
                if not path.exists(): continue
                source=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)
                try:
                    require(source.execute('PRAGMA integrity_check').fetchone()[0]=='ok','SQLITE_INTEGRITY')
                    source.execute('BEGIN');ddls=sqlite_ddl(source);bound=binding(path,force=True)
                    target=Connection(path,bound,lock=False)
                    try:
                        # Tables first: append-only triggers are installed after the copy.
                        create_schema(target,[d for d in ddls if d['type']=='table'])
                        tables=[]
                        for table in (d['name'] for d in ddls if d['type']=='table'):
                            cols=[r[1] for r in source.execute(f'PRAGMA table_info("{table}")')]
                            quoted=','.join('"'+c+'"' for c in cols)
                            require(target.cols(table)==cols,'MIGRATION_SCHEMA_MISMATCH')
                            high=target.raw.execute(f'SELECT COALESCE(MAX(rowid),0) FROM {table}').fetchone()[0]
                            if high:
                                prefix=stream_digest(source.execute(f'SELECT rowid,{quoted} FROM "{table}" WHERE rowid<=? ORDER BY rowid',(high,)))
                                require(remote_digest(target,table,quoted)==prefix,'MIGRATION_RESUME_PREFIX_MISMATCH')
                            cursor=source.execute(f'SELECT rowid,{quoted} FROM "{table}" WHERE rowid>? ORDER BY rowid',(high,))
                            while batch:=cursor.fetchmany(500):
                                with target.raw.transaction():
                                    with target.raw.cursor().copy(f'COPY {table}(rowid,{quoted}) FROM STDIN') as copy:
                                        for row in batch: copy.write_row(row)
                                if os.environ.get('AFH_SEMANTIC_CRASH_AT')=='after-copy-batch':os._exit(86)
                            expected=stream_digest(source.execute(f'SELECT rowid,{quoted} FROM "{table}" ORDER BY rowid'))
                            actual=remote_digest(target,table,quoted)
                            require(actual==expected,'MIGRATION_READBACK')
                            for col in ['rowid',*cols]:
                                seq=target.raw.execute('SELECT pg_get_serial_sequence(%s,%s)',(table,col)).fetchone()[0]
                                if seq:target.raw.execute(f"SELECT setval(%s,COALESCE(MAX(\"{col}\"),0)+1,false) FROM {table}",(seq,))
                            tables.append(dict(table=table,**expected))
                        create_schema(target,[d for d in ddls if d['type']!='table'])
                        receipt.append(dict(file=path.relative_to(root).as_posix(),schema=bound['schema'],tables=tables))
                    finally:target.close()
                finally:source.close()
        require(bool(receipt),'NO_STORES')
        # No promotion before every table has an exact complete readback.
        initial=[]
        for item in receipt:
            if item['file'].endswith('/records.sqlite3'):
                folder=Path(item['file']).parent.relative_to('semantic').as_posix();folder='' if folder=='.' else folder
                initial.append([folder,control.execute(f"SELECT revision FROM {item['schema']}.orbita_revision WHERE id=1").fetchone()[0]])
        result=dict(schema=1,namespace=entry['namespace'],backend='postgres',exportComplete=True,migration=receipt,receiptDigest=digest(receipt),initialRevisions=initial)
        atomic_json(root/'semantic'/MARKER,result)
        entry['active']=True;atomic_json(os.environ['AFH_SEMANTIC_PG_CONFIG'],cfg)
        return dict(status='PASS',stores=len(receipt),tables=sum(len(x['tables']) for x in receipt),rows=sum(t['rows'] for x in receipt for t in x['tables']),receiptDigest=result['receiptDigest'])
    finally:
        if control:control.close()
        release()

def export_held(root, progress=lambda value:None):
    """Return a live exclusive guard; caller must hold it through archive publication."""
    root=plain(root);marker=root/'semantic'/MARKER
    if not marker.exists():return None,dict(backend='sqlite')
    bound=binding(root/'semantic'/'records.sqlite3')
    if bound is None:return None,dict(backend='sqlite',restored=True)
    control=raw_connect(bound['cfg']);published=[];temps=[]
    try:
        control.execute("SET lock_timeout='20s'")
        control.execute('SELECT pg_advisory_lock(%s)',(key(bound['namespace']),))
        for folder in FOLDERS:
            for name in ('corpus.sqlite3','records.sqlite3'):
                path=plain(root/'semantic'/folder/name)
                if not path.exists(): continue
                conn=Connection(path,binding(path),lock=False,read_only=True)
                temp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.export');temps.append(temp)
                try:
                    conn.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
                    ddls=[dict(zip(('name','type','sql'),r)) for r in conn.raw.execute('SELECT name,type,sql FROM orbita_ddl ORDER BY type,name')]
                    local=sqlite3.connect(temp)
                    stage={'operation':'create_tables','file':path.relative_to(root).as_posix()}
                    last_progress=[time.monotonic()]
                    def sqlite_progress():
                        # Called only by SQLite while executing real VM operations.
                        # A stalled process does not manufacture liveness messages.
                        now=time.monotonic()
                        if now-last_progress[0]>=5:
                            progress(dict(stage));last_progress[0]=now
                        return 0
                    local.set_progress_handler(sqlite_progress,100000)
                    try:
                        for row in ddls:
                            if row['type']=='table':local.execute(row['sql'])
                        checks=[]
                        for table in (d['name'] for d in ddls if d['type']=='table'):
                            stage.update(operation='copy_and_readback',table=table)
                            cols=conn.cols(table);quoted=','.join('"'+c+'"' for c in cols)
                            with conn.raw.cursor(name='export_'+uuid.uuid4().hex) as cur:
                                cur.execute(f'SELECT rowid,{quoted} FROM {table} ORDER BY rowid')
                                def rows():
                                    for n,r in enumerate(cur,1):
                                        local.execute(f'INSERT INTO "{table}"(rowid,{quoted}) VALUES({",".join("?" for _ in range(len(cols)+1))})',r)
                                        if n%5000==0:progress(dict(table=table,rows=n))
                                        yield r
                                expected=stream_digest(rows())
                            actual=stream_digest(local.execute(f'SELECT rowid,{quoted} FROM "{table}" ORDER BY rowid'),lambda n:progress(dict(operation="readback",table=table,rows=n)))
                            require(expected==actual,'EXPORT_READBACK');checks.append(dict(table=table,**actual))
                        stage.update(operation='build_indexes_and_triggers');stage.pop('table',None)
                        for row in ddls:
                            if row['type']!='table':local.execute(row['sql'])
                        if any(d['name']=='record_versions' for d in ddls):
                            # Engine-maintained expression indexes; no mutable
                            # source-membership sidecar can omit a record.
                            local.execute("CREATE INDEX orbita_export_first_source ON record_versions(json_extract(payload,'$.source_refs[0].id'))")
                            local.execute("CREATE INDEX orbita_export_multisource ON record_versions(record_id) WHERE json_array_length(payload,'$.source_refs')>1")
                        revision=conn.raw.execute('SELECT revision FROM orbita_revision WHERE id=1').fetchone()[0]
                        local.execute('CREATE TABLE orbita_export_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL)')
                        local.execute('INSERT INTO orbita_export_revision VALUES(1,?)',(revision,))
                        for row in ddls:
                            if row['type']!='table' or row['name'] not in ('record_versions','semantic_support_admissions'):continue
                            for event in ('INSERT','UPDATE','DELETE'):
                                local.execute(f"CREATE TRIGGER orbita_export_{event.lower()}_{row['name']} AFTER {event} ON {row['name']} BEGIN UPDATE orbita_export_revision SET revision=revision+1 WHERE id=1; END")
                        stage.update(operation='commit');local.commit()
                        stage.update(operation='sqlite_integrity_check')
                        require(local.execute('PRAGMA integrity_check').fetchone()[0]=='ok','EXPORT_SQLITE_INTEGRITY')
                    finally:local.close()
                    published.append((path,temp,checks))
                finally:conn.close()
        # Guard excludes every cooperative connection, including other processes.
        for path,temp,_ in published:
            for suffix in ('-wal','-shm'):require(not Path(str(path)+suffix).exists(),'SQLITE_SIDECAR_ACTIVE')
            os.replace(temp,path)
        value=json.loads(marker.read_text(encoding='utf8'));value.update(exportComplete=True,export=[dict(file=p.relative_to(root).as_posix(),tables=c) for p,_,c in published]);atomic_json(marker,value)
        return control,dict(backend='postgres',stores=len(published),exportDigest=digest(value['export']))
    except BaseException:
        control.close()
        for temp in temps:
            if temp.exists():temp.unlink()
        raise
