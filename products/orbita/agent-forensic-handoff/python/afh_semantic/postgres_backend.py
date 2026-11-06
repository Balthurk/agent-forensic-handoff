"""Retired per-root semantic backend; pure path compatibility only.

Operational callers use common_backend. Legacy SQLite conversion is the
explicit, hash-bound orbita_store.legacy_import operator boundary. Importing a
copied config or calling an old entry point never creates a native shadow.
"""
import hashlib
import json
from .path_safety import plain_path,PathSafetyError


def plain(path):
    try:return plain_path(path).resolve()
    except PathSafetyError as error:raise ValueError('SEMANTIC_PG_'+str(error)) from error


def normalized(path):return str(plain(path)).casefold()
def canonical(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)
def digest(value):return hashlib.sha256(canonical(value).encode()).hexdigest()


def _disabled():raise RuntimeError('ORBITA_PG_LEGACY_SEMANTIC_BACKEND_DISABLED')
def read_config():_disabled()
def raw_connect(*args,**kwargs):_disabled()
def atomic_json(path,*args,**kwargs):plain(path);_disabled()
def binding(path,**kwargs):plain(path);_disabled()
def connect(path,**kwargs):plain(path);_disabled()
def state(path,**kwargs):plain(path);_disabled()


class Connection:
    def __init__(self,path,*args,**kwargs):plain(path);_disabled()
