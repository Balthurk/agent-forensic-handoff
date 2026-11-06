"""Real PostgreSQL deadlines for a complete relational read, without replay.

Milliseconds are a new explicit unit, never an emulation of SQLite VM steps.
Both authorities use one exported REPEATABLE READ snapshot. A query owns its
two transactions; caller transactions are rejected without touching them.
"""
from contextlib import contextmanager
import math
import threading
import time

import psycopg
from psycopg import sql

from .common_backend import Connection
from .knowledge_records import RecordError

DEFAULT_BUDGET = {"max_rows": 2000, "max_input_bytes": 4000000,
                  "max_query_ms": 5000, "max_work": 20000,
                  "max_edges": 1000, "max_nodes": 200,
                  "max_sources": 100, "max_source_bytes": 4000000,
                  "max_context_bytes": 64000}


class Limit(Exception):
    pass


class Budget:
    def __init__(self, limits):
        if isinstance(limits, dict) and 'max_sql_steps' in limits:
            raise RecordError('SQL_STEP_BUDGET_UNSUPPORTED', 'use explicit max_query_ms; units are not equivalent')
        if limits is not None and (not isinstance(limits, dict) or set(limits)-set(DEFAULT_BUDGET)):
            raise RecordError('INVALID_BUDGET')
        self.limits = {**DEFAULT_BUDGET, **(limits or {})}
        for name, value in self.limits.items():
            if type(value) is not int or not 1 <= value <= DEFAULT_BUDGET[name]*10:
                raise RecordError('INVALID_BUDGET', name)
        if self.limits['max_context_bytes'] < 2048:
            raise RecordError('INVALID_BUDGET', 'context minimum 2048 bytes')
        self.used = {name[4:]: 0 for name in self.limits}
        self.started = time.monotonic()
        self.deadline = self.started + self.limits['max_query_ms']/1000

    def expired(self):
        elapsed = time.monotonic()-self.started
        self.used['query_ms'] = math.ceil(elapsed*1000)
        return time.monotonic() >= self.deadline

    def check(self):
        if self.expired(): raise Limit('query_ms')

    def take(self, name, count=1):
        self.check()
        self.used[name] += count
        if self.used[name] > self.limits['max_'+name]: raise Limit(name)


@contextmanager
def read_scope(records, meter):
    connections = [records.db, getattr(records.memory, 'db', None)]
    if any(not isinstance(db, Connection) or db.closed for db in connections):
        raise RecordError('RELATIONAL_COMMON_CONNECTION_REQUIRED')
    first, second = connections
    if first is second or first.session.binding != second.session.binding or first.config != second.config:
        raise RecordError('RELATIONAL_AUTHORITY_MISMATCH')
    # Check both before modifying either, so rejected callers retain ownership.
    if any(db.in_transaction or getattr(db, '_read_budget_check', None) is not None for db in connections):
        raise RecordError('RELATIONAL_OWNED_READ_REQUIRED')
    # AFHMemory may be reused by a caller. Bind its memoized immutable rows to
    # this query's actual database snapshot, never an earlier completed read.
    source_cache = getattr(records.memory, '_binding_cache', None)
    if source_cache is not None: source_cache.clear()
    cancelled = threading.Event()
    cancel_failed = threading.Event()
    started = []

    def cancel():
        cancelled.set()
        for db in connections:
            try:
                if not db.raw.closed: db.raw.cancel_safe(timeout=1)
            except psycopg.Error:
                cancel_failed.set()

    timer = threading.Timer(max(0, meter.deadline-time.monotonic()), cancel)
    timer.daemon = True
    for db in connections: db._read_budget_check = meter.check
    try:
        timer.start()
        meter.check()
        started.append(first)
        first.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        snapshot = first.raw.execute('SELECT pg_export_snapshot()').fetchone()[0]
        started.append(second)
        second.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        second.raw.execute(sql.SQL('SET TRANSACTION SNAPSHOT {}').format(sql.Literal(snapshot)))
        for db in connections:
            meter.check()
            current = int(db.raw.execute("SELECT setting FROM pg_settings WHERE name='statement_timeout'").fetchone()[0])
            remaining = max(1, math.floor((meter.deadline-time.monotonic())*1000))
            # Retain any stricter existing server bound (55s at normal startup).
            timeout = min(remaining, current) if current else remaining
            db.raw.execute("SELECT set_config('statement_timeout',%s,true)", (str(timeout),))
        yield
        meter.check()
    except BaseException as error:
        # evidence() can wrap QueryCanceled. Only our own elapsed deadline
        # becomes a budget outcome; unrelated SQL/source failures stay failures.
        if cancelled.is_set() or meter.expired(): raise Limit('query_ms') from error
        raise
    finally:
        timer.cancel()
        if timer.ident is not None: timer.join()
        # No late cancellation can reach a subsequent call or a pooled session.
        for db in connections: db._read_budget_check = None
        if source_cache is not None: source_cache.clear()
        cleanup_failed = False
        for db in reversed(started):
            try:
                if not db.raw.closed: db.rollback()
            except psycopg.Error:
                cleanup_failed = True
                db.session.close(reusable=False)
            finally:
                if cancel_failed.is_set(): db.session.close(reusable=False)
        if cleanup_failed:
            raise RecordError('RELATIONAL_READ_CLEANUP_FAILED') from None
