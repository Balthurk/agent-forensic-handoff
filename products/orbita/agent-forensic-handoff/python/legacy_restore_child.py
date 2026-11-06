"""Qualification child: actual process loss at a publication boundary."""
import json,os,sys
from orbita_store.config import parse_config
from orbita_store.legacy_restore import restore_legacy
from orbita_store.pool import close_idle
value=json.loads(sys.stdin.buffer.read(1024**2))
def progress(event):
    if event['event']==value['crash']:os._exit(86)
try:
    result=restore_legacy(value['archive'],value['sha256'],value['destination'],value['stage'],config=parse_config(value['config']),node=value['node'],password=value['password'],private_parent=value['private'],operation_id=value['operationId'],progress=progress)
    print(json.dumps(result))
finally:close_idle()
