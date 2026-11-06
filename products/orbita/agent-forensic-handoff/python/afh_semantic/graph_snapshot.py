"""Actual common-database snapshots for graph records and their source registry."""
from contextlib import contextmanager
from psycopg import sql
from .knowledge_records import RecordError

def require(ok,code):
    if not ok:raise RecordError(code)

def import_snapshot(connection,snapshot):
    require(not connection.in_transaction,'G1_SNAPSHOT_ALREADY_ACTIVE')
    connection.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    connection.raw.execute(sql.SQL('SET TRANSACTION SNAPSHOT {}').format(sql.Literal(snapshot)))

@contextmanager
def source_snapshot(records):
    primary=records.db;source=getattr(records.memory,'db',None)
    require(source is not None,'G1_SOURCE_CONNECTION_REQUIRED')
    connections=[primary,source]
    require(all(not c.in_transaction for c in connections),'G1_SNAPSHOT_ALREADY_ACTIVE')
    require(all(c.config==primary.config and c.session.binding==primary.session.binding for c in connections),'G1_SNAPSHOT_BINDING')
    cache=getattr(records.memory,'_binding_cache',None)
    if cache is not None:cache.clear()
    try:
        primary.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        snapshot=primary.raw.execute('SELECT pg_export_snapshot()').fetchone()[0]
        if source is not None:
            require(source.raw.info.backend_pid!=primary.raw.info.backend_pid,'G1_INDEPENDENT_READER_REQUIRED')
            import_snapshot(source,snapshot)
        yield snapshot
    finally:
        error=None
        for conn in reversed(connections):
            try:
                if not conn.closed:conn.rollback()
            except Exception:
                error=RecordError('G1_SNAPSHOT_CLOSE_UNVERIFIED')
                try:conn.close()
                except Exception:pass
        if cache is not None:cache.clear()
        if error:raise error
