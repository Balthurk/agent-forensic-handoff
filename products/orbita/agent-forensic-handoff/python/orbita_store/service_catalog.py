"""Complete pg_dump schema plus typed, ordered contents of every user table.

Schema equivalence delegates to PostgreSQL's own complete schema export with
owners, ACLs, comments, RLS, functions and database settings retained. Both
exports use the same explicit restrict key; no SQL or timestamp is discarded.
Binary COPY equivalence is deliberately tied to the identical PostgreSQL image.
"""
import hashlib
import time
from psycopg import sql
from psycopg.pq import TransactionStatus
from .config import require
from .service_archive import mac

TYPES={'bool','bytea','float8','int4','int8','jsonb','text','timestamptz','uuid'}


def tables(db):
    return db.execute("SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p') ORDER BY 1,2").fetchall()


def roles(db,key,*,exclude=(),runtime_login=None):
    rows=db.execute("SELECT rolname,to_jsonb(r)-'oid' FROM pg_authid r WHERE rolname!~'^pg_' ORDER BY rolname").fetchall()
    result={}
    for name,value in rows:
        if name in exclude:continue
        if name=='orbita_runtime' and runtime_login is not None:value['rolcanlogin']=runtime_login
        result[name]=mac(key,value)
    memberships=[list(row) for row in db.execute("SELECT pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor),admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY 1,2,3").fetchall()]
    require(not any(any(name in exclude for name in row[:3]) for row in memberships),'SERVICE_BOOTSTRAP_MEMBERSHIP')
    return dict(roles=result,memberships=memberships)


def sequence_state(db, reader, *, deadline=None):
    """Sequence values are non-MVCC; read every value in bounded transactions.

    The source maintenance barrier and full before/after comparison still apply.
    An independent autocommit reader avoids retaining one lock per sequence in
    the table snapshot transaction, including on installations with 36k+ stores.
    """
    require(reader.autocommit and reader.info.transaction_status==TransactionStatus.IDLE,'SERVICE_SEQUENCE_READER_TRANSACTION')
    names=db.execute("SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname!~'^pg_' ORDER BY 1,2").fetchall()
    current=reader.execute("SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname!~'^pg_' ORDER BY 1,2").fetchall()
    require(names==current,'SERVICE_SEQUENCE_INVENTORY_CHANGED')
    result=[]
    for offset in range(0,len(names),128):
        if deadline is not None:
            require(time.monotonic()<deadline,'SERVICE_DEADLINE')
            reader.execute(sql.SQL('SET statement_timeout={}').format(sql.Literal(str(max(1,min(600000,int((deadline-time.monotonic())*1000))))+'ms')))
        batch=names[offset:offset+128]
        query=sql.SQL(' UNION ALL ').join(sql.SQL('SELECT {},last_value,is_called FROM {}').format(sql.Literal(i),sql.Identifier(*name)) for i,name in enumerate(batch))
        rows=reader.execute(query).fetchall();require(len(rows)==len(batch),'SERVICE_SEQUENCE_CARDINALITY')
        for i,last,called in sorted(rows):
            schema,name=batch[i];result.append(dict(schema=schema,name=name,lastValue=last,isCalled=called))
    return result


def state(db,*,key,schema_bytes,exclude_roles=(),runtime_login=None,deadline=None,sequence_reader=None):
    db.execute("SET timezone='UTC'");db.execute("SET search_path=pg_catalog")
    unsupported=db.execute("SELECT n.nspname,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('f','m')").fetchall()
    require(not unsupported,'SERVICE_UNQUALIFIED_RELATION_KIND')
    require(db.execute('SELECT count(*) FROM pg_largeobject_metadata').fetchone()[0]==0,'SERVICE_UNQUALIFIED_LARGE_OBJECTS')
    require(db.execute('SELECT count(*) FROM pg_subscription').fetchone()[0]==0,'SERVICE_UNQUALIFIED_SUBSCRIPTIONS')
    require(db.execute("SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global')").fetchone()[0]==0,'SERVICE_EXTERNAL_TABLESPACE')
    values=[]
    for schema,name in tables(db):
        if deadline is not None:
            require(time.monotonic()<deadline,'SERVICE_DEADLINE')
            db.execute(sql.SQL('SET statement_timeout={}').format(sql.Literal(str(max(1,min(600000,int((deadline-time.monotonic())*1000))))+'ms')))
        oid=db.execute('SELECT %s::regclass::oid',(sql.Identifier(schema,name).as_string(db),)).fetchone()[0]
        columns=db.execute("SELECT a.attname,n.nspname,t.typname FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE a.attrelid=%s AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",(oid,)).fetchall()
        require(all(n=='pg_catalog' and t in TYPES for _,n,t in columns),'SERVICE_UNQUALIFIED_COPY_TYPE')
        primary=db.execute("SELECT a.attname FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,position) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE i.indrelid=%s AND i.indisprimary AND i.indisvalid ORDER BY k.position",(oid,)).fetchall()
        require(bool(primary),'SERVICE_PRIMARY_KEY_REQUIRED')
        names=sql.SQL(',').join(sql.Identifier(row[0]) for row in columns);order=sql.SQL(',').join(sql.Identifier(row[0]) for row in primary)
        query=sql.SQL('COPY (SELECT {} FROM ONLY {} ORDER BY {}) TO STDOUT (FORMAT BINARY)').format(names,sql.Identifier(schema,name),order)
        digest=hashlib.sha256();size=0
        with db.cursor() as cursor:
            with cursor.copy(query) as copy:
                for block in copy:digest.update(block);size+=len(block)
        count=db.execute(sql.SQL('SELECT count(*) FROM ONLY {}').format(sql.Identifier(schema,name))).fetchone()[0]
        values.append(dict(schema=schema,name=name,columns=[row[0] for row in columns],primaryKey=[row[0] for row in primary],rows=count,bytes=size,sha256=digest.hexdigest()))
    sequences=sequence_state(db,sequence_reader or db,deadline=deadline)
    settings=db.execute("SELECT name,setting,unit FROM pg_settings WHERE context IN ('postmaster','sighup') ORDER BY name").fetchall()
    extensions=[dict(name=row[0],version=row[1],schema=row[2],owner=row[3],relocatable=row[4]) for row in db.execute('SELECT e.extname,e.extversion,n.nspname,pg_get_userbyid(e.extowner),e.extrelocatable FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY e.extname')]
    return dict(schemaSha256=hashlib.sha256(schema_bytes).hexdigest(),schemaBytes=len(schema_bytes),tables=values,sequences=sequences,extensions=extensions,
                roles=roles(db,key,exclude=exclude_roles,runtime_login=runtime_login),serverConfigurationHmac=mac(key,settings))
