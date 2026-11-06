"""Operator verification of the complete declared schema, without fixtures."""
from pathlib import Path
import hashlib,json
from psycopg.types.json import Jsonb
from .config import require
from .schema import definitions,ident,qtable,install_family

FAMILIES=frozenset('case access capture library documents embedding federation reevaluation generation pipeline lease turns volume vector corpus semantic graph graph_ledger graph_mirror'.split())
ROOT=Path(__file__).parent


def stable(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf8')
def sha(value):return hashlib.sha256(value).hexdigest()


def schema_bundle():
    root=ROOT/'schemas';raw=(root/'manifest.json').read_bytes();manifest=json.loads(raw)
    require(manifest['schema']==1 and set(manifest['families'])==FAMILIES,'INSTALL_BUNDLE_FAMILIES')
    require({p.stem for p in root.glob('*.sql')}==FAMILIES,'INSTALL_BUNDLE_FILES')
    bundle={}
    for family in sorted(FAMILIES):
        record=manifest['families'][family];require(record['file']==family+'.sql','INSTALL_BUNDLE_PATH')
        source=(root/record['file']).read_bytes();require(sha(source)==record['sha256'],'INSTALL_BUNDLE_HASH')
        items=list(definitions(source.decode('utf8'),family))
        require({i['name']:i['source_hash'] for i in items}==record['members'] and len(items)==record['definitions'] and sum(i['kind']=='table' for i in items)==record['tables'],'INSTALL_BUNDLE_DEFINITIONS')
        bundle[family]=dict(source=source.decode('utf8'),items=items)
    require(sum(i['kind']=='table' for b in bundle.values() for i in b['items'])==98,'INSTALL_BUNDLE_TABLE_COUNT')
    sources={p.name:sha(p.read_bytes()) for p in ROOT.glob('*.sql')}
    sources.update({name:sha((ROOT/name).read_bytes()) for name in ('admin.py','installation.py','schema.py','sql.py')})
    package=dict(manifestSha256=sha(raw),sources=sources)
    return bundle,dict(**package,sha256=sha(stable(package)))


def physical_state(db,bundle):
    """No row contents, OIDs, passwords or capabilities enter this record."""
    tables={}
    for family,value in bundle.items():
        expected={i['name'] for i in value['items'] if i['kind']=='table'}
        actual={r[0] for r in db.execute("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=%s AND c.relkind IN ('r','p')",('orbita_'+family,))}
        require(actual==expected,'INSTALL_PHYSICAL_TABLE_SET')
        for name in sorted(expected):
            target=qtable(family,name)
            flags=db.execute('SELECT relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner),relacl::text FROM pg_class WHERE oid=%s::regclass',(target,)).fetchone()
            columns=db.execute("SELECT a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=%s::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",(target,)).fetchall()
            constraints=db.execute('SELECT conname,contype,pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid=%s::regclass ORDER BY conname',(target,)).fetchall()
            indexes=db.execute('SELECT c.relname,i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=%s::regclass ORDER BY c.relname',(target,)).fetchall()
            triggers=db.execute('SELECT tgname,tgenabled,pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid=%s::regclass AND NOT tgisinternal ORDER BY tgname',(target,)).fetchall()
            policies=db.execute('SELECT polname,polcmd,polpermissive,pg_get_expr(polqual,polrelid),pg_get_expr(polwithcheck,polrelid),polroles FROM pg_policy WHERE polrelid=%s::regclass ORDER BY polname',(target,)).fetchall()
            tables[family+'.'+name]=dict(flags=flags,columns=columns,constraints=constraints,indexes=indexes,triggers=triggers,policies=policies)
    return json.loads(stable(tables))


def verify_schema(db,bundle):
    role=db.execute("SELECT rolcanlogin,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='orbita_runtime'").fetchone()
    require(role==(True,False,False,False,False,False,False),'INSTALL_RUNTIME_ROLE')
    require(db.execute("SELECT count(*) FROM pg_auth_members WHERE member='orbita_runtime'::regrole").fetchone()[0]==0,'INSTALL_RUNTIME_MEMBERSHIP')
    physical=physical_state(db,bundle)
    read='(_store_id = ( SELECT orbita_common.store_id() AS store_id))'
    write='((_store_id = ( SELECT orbita_common.store_id() AS store_id)) AND ( SELECT orbita_common.can_write() AS can_write))'
    policies=[['store_read','r',True,read,None,[0]],['store_write','*',True,write,write,[0]]]
    for family,value in bundle.items():
        actual=db.execute('SELECT name,source_hash FROM orbita_private.schema_catalog WHERE family=%s ORDER BY name',(family,)).fetchall()
        require(dict(actual)=={i['name']:i['source_hash'] for i in value['items']},'INSTALL_CATALOGUE')
        for item in value['items']:
            if item['kind']!='table':continue
            target=qtable(family,item['name']);observed=physical[family+'.'+item['name']];definition=item['definition']
            require(observed['flags'][:2]==[True,True] and observed['flags'][2]!='orbita_runtime','INSTALL_TABLE_AUTHORITY')
            expected=[['_store_id','uuid',True,'']]+[[c['name'],c['type'].lower(),c['notnull'] or c['primary'],''] for c in definition['columns']]
            alias=definition['rowidAlias']
            if not any(c[0]=='rowid' for c in expected):expected.append(['rowid','bigint',not bool(alias),'s' if alias else ''])
            if family=='vector' and item['name']=='vector_index':expected.append(['_index_ordinal','bigint',False,''])
            require([c[:4] for c in observed['columns']]==expected,'INSTALL_COLUMN_SHAPE')
            require(observed['policies']==policies,'INSTALL_ROW_POLICIES')
            require(all(i[1] and i[2] for i in observed['indexes']),'INSTALL_INDEX_STATE')
            for privilege in ('SELECT','INSERT','UPDATE','DELETE'):
                require(db.execute('SELECT has_table_privilege(%s,%s,%s)',('orbita_runtime',target,privilege)).fetchone()[0],'INSTALL_RUNTIME_GRANTS')
            require(not db.execute("SELECT has_table_privilege('orbita_runtime',%s,'TRUNCATE')",(target,)).fetchone()[0],'INSTALL_RUNTIME_TRUNCATE')
            require(db.execute("SELECT count(*) FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=%s::regclass AND a.grantee=0",(target,)).fetchone()[0]==0,'INSTALL_PUBLIC_TABLE_GRANT')
            names={t[0] for t in observed['triggers']}
            require({'orbita_assign_rowid','orbita_remember_insert'}<=names and all(t[1]=='O' for t in observed['triggers']),'INSTALL_TABLE_TRIGGERS')
    require(db.execute("SELECT count(*) FROM pg_namespace WHERE nspname='orbita_private' AND has_schema_privilege('orbita_runtime',oid,'USAGE')").fetchone()[0]==0,'INSTALL_PRIVATE_SCHEMA')
    return physical


def install_complete(db,bundle,package):
    # The outer installer transaction owns bootstrap, all families and receipt.
    # No intermediate commit can expose a partially prepared fresh database.
    previous=None
    if db.execute("SELECT to_regclass('orbita_private.installation')").fetchone()[0]:
        previous=db.execute('SELECT receipt FROM orbita_private.installation WHERE singleton').fetchone()
    if previous is not None:
        require(sha(stable(physical_state(db,bundle)))==previous[0]['physicalSha256'],'INSTALL_EXISTING_PHYSICAL_DRIFT')
    for family,value in bundle.items():install_family(db,family,value['source'])
    physical=verify_schema(db,bundle)
    receipt=dict(schema='orbita-complete-install-1',package=package,families=len(bundle),tables=len(physical),physicalSha256=sha(stable(physical)),runtimeRole='orbita_runtime',runtimeBypassRls=False)
    db.execute('CREATE TABLE IF NOT EXISTS orbita_private.installation(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),receipt jsonb NOT NULL)')
    db.execute('REVOKE ALL ON orbita_private.installation FROM PUBLIC,orbita_runtime')
    db.execute('INSERT INTO orbita_private.installation(singleton,receipt) VALUES(true,%s) ON CONFLICT(singleton) DO UPDATE SET receipt=excluded.receipt',(Jsonb(receipt),))
    return receipt
