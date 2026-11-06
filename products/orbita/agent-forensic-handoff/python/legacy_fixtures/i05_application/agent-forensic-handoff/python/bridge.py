import sys,json
from pathlib import Path
# -I ignores PYTHONPATH/user site; this is the only application import root.
sys.path.insert(0,str(Path(__file__).resolve().parent))
from afh_semantic.host import dispatch
from store_access import use_store
def unique(pairs):
    result={}
    for k,v in pairs:
        if k in result:raise ValueError('DUPLICATE_JSON_KEY')
        result[k]=v
    return result
try:
    sys.stdin.reconfigure(encoding='utf8');sys.stdout.reconfigure(encoding='utf8')
    data=sys.stdin.read(32000001)
    if len(data)>32000000:raise ValueError('BRIDGE_INPUT_BUDGET')
    request=json.loads(data,object_pairs_hook=unique,parse_constant=lambda x:(_ for _ in ()).throw(ValueError('NONFINITE_JSON')))
    use_store(Path(request['root']).resolve().parent)
    print(json.dumps({'ok':True,'result':dispatch(request)},ensure_ascii=False,allow_nan=False))
except Exception as error:
    print(json.dumps({'ok':False,'error':str(error),'type':type(error).__name__},ensure_ascii=False));sys.exit(1)
