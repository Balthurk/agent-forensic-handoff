import json
class QueryAborted(RuntimeError): pass
class PackageInputError(ValueError): pass
def _deadline_connect(*args,**kwargs):
    raise RuntimeError('ORBITA_PG_LEGACY_SQLITE_RUNTIME_DISABLED')
def serialize(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode('utf8')
