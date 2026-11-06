"""Authenticated, instance-bound PostgreSQL sessions with no reconnect/replay."""
import psycopg

from . import StoreError, SCHEMA_VERSION
from .config import require
from .pool import acquire,release


class Session:
    def __init__(self, config, binding, *, read_only=False):
        self.config = config
        self.binding = binding
        self.read_only = read_only
        self.closed = False
        self.raw = None
        try:
            self.raw = acquire(config)
            self.raw.execute("SET statement_timeout = '55s'; SET lock_timeout = '5s'; "
                             "SET idle_in_transaction_session_timeout = '60s'; "
                             "SET synchronous_commit = 'on'; SET search_path = pg_catalog, orbita_common").close()
            identity = self.raw.execute('SELECT instance_id::text, version, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb '
                                       'FROM orbita_common.identity CROSS JOIN pg_roles WHERE rolname=current_user').fetchall()
            require(len(identity)==1 and identity[0][:2] == (config.instance_id, SCHEMA_VERSION), 'INSTANCE_MISMATCH')
            require(identity[0][2:] == (False, False, False, False), 'PRIVILEGED_RUNTIME_ROLE')
            self.raw.execute('SELECT orbita_common.authorize_workspace(%s::uuid, %s, %s)', (binding.workspace_id, binding.capability,read_only))
        except BaseException as error:
            if self.raw is not None:
                self.raw.close()
            self.closed = True
            if isinstance(error, StoreError):
                raise
            raise StoreError('ORBITA_PG_CONNECT_OR_AUTHORIZE_FAILED') from None

    def open_store(self, key, family, *, create=False):
        require(not self.closed, 'SESSION_CLOSED')
        require(not self.read_only or not create, 'READ_ONLY')
        try:
            row = self.raw.execute('SELECT orbita_common.open_store(%s, %s, %s)::text', (key, family, create)).fetchone()
        except psycopg.Error as error:
            raise StoreError('ORBITA_PG_' + ('STORE_NOT_FOUND' if error.sqlstate == 'P0002' else 'STORE_BINDING_REJECTED')) from None
        self.store_id = row[0]
        return self.store_id

    def begin(self, *, immediate=False):
        require(not self.closed, 'SESSION_CLOSED')
        self.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' if self.read_only else 'BEGIN')
        if immediate and not self.read_only:
            self.raw.execute("SELECT pg_advisory_xact_lock(hashtextextended('store:' || orbita_common.store_id()::text, 0))")

    def close(self,*,reusable=True):
        if not self.closed:
            self.closed = True
            if reusable:release(self.config,self.raw)
            else:self.raw.close()

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        self.close()
