"""Historical Janus entrypoints are closed; use the common graph protocol.

Original implementation and qualification evidence remain in the sealed I05
parent. Import of old data is a separately authorized read-only boundary.
"""
from .knowledge_records import RecordError
def unavailable(*args,**kwargs):raise RecordError('G1_REMOTE_BACKEND_NOT_QUALIFIED')
dispatch_remote=unavailable
capabilities=unavailable
class Ledger:
    def __init__(self,*args,**kwargs):unavailable()
