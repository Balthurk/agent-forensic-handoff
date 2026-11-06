"""Bounded complete legacy PG catalog comparison; no source DDL or row output.

Native recovery keeps PostgreSQL OIDs and the exact image. COPY binary hashes
are therefore directly comparable. Every table is one autocommit read; schema
exports cover every namespace in bounded batches, without one 25k-table lock.
"""
import hashlib, time
from psycopg import sql
from psycopg.pq import TransactionStatus
from orbita_store.config import require
from orbita_store.service_archive import mac
from orbita_store.service_backup import capture, pg_command
from orbita_store.service_catalog import roles, sequence_state

TYPES={'int4','int8','text','_text'}

def bounded(db,deadline):
    require(time.monotonic()<deadline,'LEGACY_CATALOG_DEADLINE')
    db.execute(sql.SQL('SET statement_timeout={}').format(sql.Literal(str(max(1,min(600000,int((deadline-time.monotonic())*1000))))+'ms')))

def copy_digest(db,query,*,deadline):
    bounded(db,deadline); digest=hashlib.sha256();size=0
    with db.cursor() as cursor:
        with cursor.copy(query) as copy:
            for block in copy:
                require(time.monotonic()<deadline,'LEGACY_COPY_DEADLINE')
                size+=len(block);require(size<=50*1024**3,'LEGACY_TABLE_COPY_BUDGET');digest.update(block)
        count=cursor.rowcount
    require(count>=0,'LEGACY_COPY_CARDINALITY_UNAVAILABLE')
    return dict(rows=count,bytes=size,sha256=digest.hexdigest())

def ordered_copy(columns,primary,relation):
    names=sql.SQL(',').join(sql.Identifier(row[0]) for row in columns)
    if primary:
        order=sql.SQL(',').join(sql.Identifier(name) for name in primary)
    else:
        # Full value ordering includes arrays, nulls and duplicate multiplicity.
        order=sql.SQL(',').join(sql.SQL('{} COLLATE "C" NULLS LAST').format(sql.Identifier(name))
                               if typ in ('text','_text') else sql.SQL('{} NULLS LAST').format(sql.Identifier(name))
                               for name,namespace,typ in columns)
    return sql.SQL('COPY (SELECT {} FROM {} ORDER BY {}) TO STDOUT (FORMAT BINARY)').format(names,relation,order)

def qualify_values(db,*,deadline):
    columns=[('odd "text','pg_catalog','text'),('a','pg_catalog','_text'),('n','pg_catalog','int8')]
    values=[(None,['z',None],-2),('ñ🚀',[None,''],9223372036854775807),('same',['x'],5),('same',['x'],5),('',[],None)]
    def one(rows):
        literals=sql.SQL(',').join(sql.SQL('({}::text,{}::text[],{}::bigint)').format(*(sql.Literal(x) for x in row)) for row in rows)
        relation=sql.SQL('(VALUES {}) AS t({})').format(literals,sql.SQL(',').join(sql.Identifier(c[0]) for c in columns))
        return copy_digest(db,ordered_copy(columns,[],relation),deadline=deadline)
    base=one(values);require(base['rows']==5 and one(list(reversed(values)))==base,'LEGACY_COPY_ORDER_EQUIVALENCE')
    mutations=[values[:-1],values+[values[-1]],[(None,['z',None],-1),*values[1:]],
               [values[0],('ñ🚀',['',''],9223372036854775807),*values[2:]],
               [values[0],('ñ🚀',[None,''],9223372036854775806),*values[2:]],
               [*values[:-1],('',[None],None)]]
    require(all(one(changed)!=base for changed in mutations),'LEGACY_COPY_MUTATION_NOT_DETECTED')
    return dict(status='PASS_READ_ONLY_TYPED_COPY_DIFFERENTIAL_CANARIES',equivalentOrders=2,changedContentOrMultiplicityDetected=len(mutations),
                rows=base['rows'],includes=['quoted identifiers','unicode','int64 extrema','NULL scalar','NULL array element','empty array','duplicate rows'],databaseMutations=False)

def state(db,service,operator,backup_id,*,key,deadline,progress=lambda **kw:None):
    require(db.autocommit and db.info.transaction_status==TransactionStatus.IDLE,'LEGACY_CATALOG_REQUIRES_AUTOCOMMIT')
    db.execute("SET timezone='UTC'");db.execute('SET search_path=pg_catalog');db.execute("SET lock_timeout='5s'")
    bounded(db,deadline)
    names=db.execute("SELECT n.nspname,count(c.oid) FILTER(WHERE c.relkind IN ('r','p','S','v','m','f')) FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace=n.oid WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' GROUP BY 1 ORDER BY 1").fetchall()
    unsupported=db.execute("SELECT n.nspname,c.relname,c.relkind,c.relpersistence FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND (c.relkind IN ('f','m','p') OR c.relpersistence<>'p')").fetchall()
    require(not unsupported,'LEGACY_UNQUALIFIED_RELATION_KIND_OR_PERSISTENCE')
    require(db.execute('SELECT (SELECT count(*) FROM pg_largeobject_metadata)+(SELECT count(*) FROM pg_subscription)+(SELECT count(*) FROM pg_foreign_server)').fetchone()[0]==0,'LEGACY_EXTERNAL_OR_LARGE_OBJECT_CONTENT')
    # One export contains all non-table objects and database metadata. Each
    # namespace also occurs in exactly one full schema-only batch. Duplicated
    # declarations are compared byte-for-byte, never normalized away.
    batches=[];batch=[];total=0
    for name,count in names:
        require(count<=512,'LEGACY_SINGLE_NAMESPACE_LOCK_BUDGET')
        if batch and (total+count>512 or len(batch)>=128):batches.append(batch);batch=[];total=0
        batch.append(name);total+=count
    if batch:batches.append(batch)
    require([n for b in batches for n in b]==[n for n,_ in names],'LEGACY_SCHEMA_BATCH_COVERAGE')
    common=['--schema-only','--create','--dbname='+operator['dbname'],'--restrict-key='+backup_id.replace('-',''),'--lock-wait-timeout=5s']
    schemas=[]
    for index,options in enumerate([['--exclude-table=*.*']]+[['--schema='+sql.Identifier(n).as_string(db) for n in batch] for batch in batches]):
        require(time.monotonic()<deadline,'LEGACY_SCHEMA_DEADLINE')
        command=pg_command(service,operator,'pg_dump',*common,*options)
        command[2:2]=['--env','PGAPPNAME='+service['readApplicationName']]
        raw=capture(command,deadline=deadline)
        schemas.append(dict(kind='all-non-table-and-database' if index==0 else 'namespace-batch',namespaces=[] if index==0 else batches[index-1],bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest()))
        progress(event='schema_batch',completed=index+1,total=len(batches)+1)
    meta=db.execute("SELECT c.oid,n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND c.relkind='r' ORDER BY 2,3").fetchall()
    attributes=db.execute("SELECT a.attrelid,a.attname,tn.nspname,t.typname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_type t ON t.oid=a.atttypid JOIN pg_namespace tn ON tn.oid=t.typnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attrelid,a.attnum").fetchall()
    pkeys=db.execute("SELECT i.indrelid,a.attname FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,position) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND i.indisprimary AND i.indisvalid AND k.position<=i.indnkeyatts ORDER BY i.indrelid,k.position").fetchall()
    columns={};primary={}
    for oid,name,ns,typ in attributes:
        require(ns=='pg_catalog' and typ in TYPES,'LEGACY_UNQUALIFIED_COPY_TYPE')
        columns.setdefault(oid,[]).append((name,ns,typ))
    for oid,name in pkeys:primary.setdefault(oid,[]).append(name)
    values=[]
    for index,(oid,namespace,name) in enumerate(meta,1):
        cols=columns.get(oid,[]);require(cols,'LEGACY_ZERO_COLUMN_TABLE_REQUIRES_REVIEW')
        pk=primary.get(oid,[])
        query=ordered_copy(cols,pk,sql.SQL('ONLY {}').format(sql.Identifier(namespace,name)))
        value=copy_digest(db,query,deadline=deadline)
        values.append(dict(schema=namespace,name=name,columns=cols,primaryKey=pk,order='primary-key' if pk else 'all-values-C-collation',**value))
        if index%250==0 or index==len(meta):progress(event='table_contents',completed=index,total=len(meta),rows=sum(x['rows'] for x in values))
    sequences=sequence_state(db,db,deadline=deadline)
    extensions=[list(row) for row in db.execute('SELECT e.extname,e.extversion,n.nspname,pg_get_userbyid(e.extowner),e.extrelocatable FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY e.extname')]
    settings=db.execute("SELECT name,setting,unit FROM pg_settings WHERE context IN ('postmaster','sighup') ORDER BY name").fetchall()
    fresh_names=db.execute("SELECT n.nspname,count(c.oid) FILTER(WHERE c.relkind IN ('r','p','S','v','m','f')) FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace=n.oid WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' GROUP BY 1 ORDER BY 1").fetchall()
    require(names==fresh_names,'LEGACY_NAMESPACE_DRIFT')
    require(meta==db.execute("SELECT c.oid,n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND c.relkind='r' ORDER BY 2,3").fetchall(),'LEGACY_TABLE_DRIFT')
    return dict(schemaExports=schemas,namespaces=[list(r) for r in names],tables=values,sequences=sequences,extensions=extensions,
                roles=roles(db,key),serverConfigurationHmac=mac(key,settings))
