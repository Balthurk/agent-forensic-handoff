"""Bounded idle transports; every checkout must authenticate a new Session.

No connection is shared by active owners, no failed operation is retried, and
returning a transport requires rollback, deauthorization and DISCARD ALL.
"""
import atexit
from threading import Lock
import psycopg
from .ownership import owner_name

_PROCESS_OWNER_NAME=owner_name()

_idle=[]
_lock=Lock()
MAX_IDLE=8


def _key(config):
    return (*tuple(getattr(config,k) for k in ('host','port','dbname','user','password','instance_id')),_PROCESS_OWNER_NAME)


def acquire(config):
    key=_key(config)
    with _lock:
        for index in range(len(_idle)-1,-1,-1):
            candidate,db=_idle[index]
            if candidate==key:
                _idle.pop(index)
                if not db.closed:return db
    # Only SQL plans are retained inside one logical Session. Returning this
    # transport clears the driver's plans before DISCARD ALL; fresh authority
    # is still checked by every statement and by each new Session.
    return psycopg.connect(**config.connection_parameters(),connect_timeout=5,autocommit=True,
                           prepare_threshold=5,application_name=_PROCESS_OWNER_NAME)


def release(config,db):
    if db.closed:return
    try:
        db.rollback()
        # With the pinned psycopg 3.2.9, rollback on an idle connection is a
        # no-op. A fresh empty transaction makes its public rollback() reset
        # both client and server prepared plans. DISCARD ALL alone would leave
        # stale client statement names on the next logical Session.
        db.execute('BEGIN',prepare=False).close()
        db.rollback()
        db.execute('SELECT orbita_common.deauthorize()',prepare=False).close()
        db.execute('DISCARD ALL',prepare=False).close()
    except psycopg.Error:
        db.close()
        return
    with _lock:
        if len(_idle)<MAX_IDLE:
            _idle.append((_key(config),db))
            return
    db.close()


def close_idle():
    with _lock:
        connections=[db for _,db in _idle]
        _idle.clear()
    for db in connections:db.close()


atexit.register(close_idle)
