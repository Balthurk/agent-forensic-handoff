"""Qualification-only import of an explicitly owned copy of a legacy fixture."""
from pathlib import Path
import json
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from orbita_store.config import read_config
from orbita_store.legacy_plan import build_plan
from orbita_store.legacy_import import import_bundle
from orbita_store.pool import close_idle

try:
    source,destination,stage=map(Path,sys.argv[1:])
    plan=build_plan(source)
    result=import_bundle(plan,destination,stage,config=read_config())
    print(json.dumps({'status':result['status'],'planSha256':result['planSha256']}))
finally:
    close_idle()
