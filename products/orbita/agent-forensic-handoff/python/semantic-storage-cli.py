import json, sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from afh_semantic.postgres_backend import state
from afh_semantic.postgres_migration import migrate, export_held
sys.stdin.reconfigure(encoding='utf8');sys.stdout.reconfigure(encoding='utf8')
guard=None
try:
    request=json.loads(sys.stdin.readline(10000));op=request['op']
    if op=='state':result=state(request['root'])
    elif op=='migrate':result=migrate(request['root'])
    elif op=='export':guard,result=export_held(request['root'],progress=lambda value:print(json.dumps({'progress':value}),flush=True))
    else:raise ValueError('SEMANTIC_STORAGE_OPERATION')
    print(json.dumps({'ok':True,'result':result}),flush=True)
    if op=='export' and guard:sys.stdin.readline(100)
except Exception as error:
    print(json.dumps({'ok':False,'error':str(error)}),flush=True);sys.exit(1)
finally:
    if guard:guard.close()
