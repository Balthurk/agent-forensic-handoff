"""Read-only common-service inspection. Never migrate or export a native shadow."""
import json, sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from orbita_store.bridge import Bridge
from orbita_store.config import require
sys.stdin.reconfigure(encoding='utf8',errors='strict');sys.stdout.reconfigure(encoding='utf8',errors='strict')
bridge=None
try:
    raw=sys.stdin.readline(10001);require(len(raw.encode('utf8'))<=10000 and raw.endswith('\n'),'INSPECTION_REQUEST_LIMIT')
    request=json.loads(raw);require(set(request)=={'op','root'} and request['op']=='state','EXPLICIT_LEGACY_IMPORT_OR_BACKUP_REQUIRED')
    bridge=Bridge();health=bridge.call(dict(op='health',path=request['root']))['health']
    store,key=bridge.object_store(request['root'],read_only=True);store.session.begin()
    require(store.stat(key)['kind']=='directory','INSPECTION_ROOT_DIRECTORY')
    prefix=(key+'/' if key else '')+'semantic/'
    rows=store.raw.execute("SELECT path,kind,revision,store_id::text FROM orbita_common.entries WHERE starts_with(path,%s) AND kind='store' ORDER BY path COLLATE \"C\" LIMIT 10001",(prefix,)).fetchall()
    require(len(rows)<=10000,'INSPECTION_STORE_LIMIT')
    snapshot=store.raw.execute('SELECT pg_current_snapshot()::text').fetchone()[0]
    stores=[dict(path=row[0][len(prefix):],kind=row[1],nameRevision=row[2],storeId=row[3]) for row in rows]
    result=dict(backend='postgresql-common',instanceId=health['instanceId'],workspaceId=health['workspaceId'],stores=stores,snapshot=snapshot,storeHeadersOnly=True,readOnly=True)
    store.raw.rollback()
    bridge.close();bridge=None
    print(json.dumps({'ok':True,'result':result}),flush=True)
except Exception as error:
    print(json.dumps({'ok':False,'error':getattr(error,'code',None) or 'SEMANTIC_STORAGE_FAILED'}),flush=True);sys.exit(1)
finally:
    if bridge is not None:bridge.close()
