import sqlite3, json
class QueryAborted(RuntimeError): pass
class PackageInputError(ValueError): pass
def _deadline_connect(*args,**kwargs):
    return sqlite3.connect(*args,**kwargs)
def serialize(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode('utf8')
