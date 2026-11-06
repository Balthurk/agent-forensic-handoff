"""Held-child test helper: synthetic import crash injection only."""
import json,os,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from orbita_store.config import read_config
from orbita_store.legacy_import import import_bundle
from orbita_store.pool import close_idle
request=json.loads(sys.stdin.buffer.readline())
def progress(event):
    if request.get('crashAt')==event['event']:os._exit(86)
try:
    result=import_bundle(request['plan'],request['destination'],request['stage'],config=read_config(),progress=progress,vector_extension=request.get('vectorExtension'))
    print(json.dumps(result,ensure_ascii=False))
finally:close_idle()
