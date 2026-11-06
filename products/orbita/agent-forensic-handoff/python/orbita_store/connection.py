"""Explicit application SQL adapter for the common PostgreSQL database.

There is no embedded engine, automatic database creation or reconnect/replay.
Only reviewed relational statements and installed definitions are accepted.
"""
from collections.abc import Mapping
from contextlib import contextmanager
from functools import lru_cache
import re
import threading

import psycopg
from psycopg.pq import TransactionStatus
from sqlglot import exp
from sqlglot.optimizer.scope import traverse_scope

from . import StoreError
from .config import require, binding_for
from .schema import definitions, ident
from .session import Session
from .sql import parameterize, parse, postgres, statements
from . import fts


class Row:
    """Ordered tuple values with named access, matching the public row contract."""
    def __init__(self, cursor, values):
        self._names=tuple(d[0] for d in cursor.description)
        self._values=tuple(values)

    def __getitem__(self,key):
        if isinstance(key,str):
            for i,name in enumerate(self._names):
                if name.lower()==key.lower():return self._values[i]
            raise IndexError('No item with that key')
        return self._values[key]

    def __iter__(self):return iter(self._values)
    def __len__(self):return len(self._values)
    def keys(self):return list(self._names)
    def __eq__(self,other):return isinstance(other,Row) and self._names==other._names and self._values==other._values


class Cursor:
    def __init__(self, connection, raw=None, *, rows=None, names=(), rowcount=-1, lastrowid=None):
        self.connection=connection
        self.raw=raw
        self._rows=iter(rows or [])
        self.description=raw.description if raw is not None else (tuple((n,None,None,None,None,None,None) for n in names) or None)
        self.rowcount=raw.rowcount if raw is not None else rowcount
        self.lastrowid=lastrowid
        self.arraysize=1
        self.closed=False

    def _convert(self,value):
        if value is None:return None
        factory=self.connection.row_factory
        return factory(self,value) if factory is not None else tuple(value)

    def fetchone(self):
        try:
            require(not self.closed,'CURSOR_CLOSED')
            value=self.raw.fetchone() if self.raw is not None else next(self._rows,None)
            return self._convert(value)
        except BaseException:
            self.connection.fail_atomic_batch()
            raise

    def fetchmany(self,size=None):
        result=[]
        for _ in range(self.arraysize if size is None else size):
            item=self.fetchone()
            if item is None:break
            result.append(item)
        return result

    def fetchall(self):return list(self)
    def __iter__(self):return self
    def __next__(self):
        item=self.fetchone()
        if item is None:raise StopIteration
        return item
    def close(self):
        if not self.closed and self.raw is not None:self.raw.close()
        self.closed=True


def _source_name(table):
    return table.name.lower()


@lru_cache(maxsize=512)
def _definition_identity(family, source):
    # Cache only immutable compilation, never authority or database state.
    items=list(definitions(source,family))
    require(len(items)==1,'SQL_SINGLE_DEFINITION_REQUIRED')
    return items[0]['name'],items[0]['source_hash']


@lru_cache(maxsize=512)
def _read_tree(query, family, catalogue):
    """Cache only compiled syntax keyed by the freshly read column contract.

    No Session, capability, parameter value, query result or open cursor can
    enter this cache. Every use still executes under the caller's real RLS,
    transaction and savepoint. A different family/shape gets a different plan.
    """
    node=parse(query)
    if not isinstance(node,(exp.Select,exp.Union)):return None
    compiler=object.__new__(Connection)
    compiler.catalog={name:dict(kind=kind,columns=[dict(name=c) for c in columns])
                      for name,kind,columns in catalogue}
    return compiler._normalize(node)


@lru_cache(maxsize=512)
def _read_plan(query, family, catalogue):
    node=_read_tree(query,family,catalogue)
    if node is None:return None
    # Lexical MATCH is an explicitly bounded reader, not ordinary SQL.
    if node.find(exp.Match) is not None:return None
    return postgres(node)


def _compile_write(query, family, catalogue):
    """Immutable SQL only: no values, sessions, results or authority decisions."""
    node=parse(query)
    require(isinstance(node,(exp.Insert,exp.Update,exp.Delete)),'ATOMIC_WRITES_STATEMENT')
    require(node.find(exp.Returning) is None,'ATOMIC_WRITES_RETURNING')
    compiler=object.__new__(Connection)
    compiler.catalog={name:dict(kind=kind,columns=[dict(name=c) for c in columns],
                               primary=list(primary),unique=[list(k) for k in unique])
                      for name,kind,columns,primary,unique in catalogue}
    node=compiler._normalize(node)
    require(node.find(exp.Match) is None,'ATOMIC_WRITES_FTS')
    if not isinstance(node,exp.Insert):return ((postgres(node),True),),False
    table,meta,columns,alternative,supplied=compiler._prepare_insert(node)
    if alternative!='REPLACE':return ((postgres(node),True),),True
    require(isinstance(node.expression,exp.Values),'SQL_REPLACE_VALUES_REQUIRED')
    constraints=([meta['primary']] if meta['primary'] else [])+meta['unique']
    if 'rowid' in columns:constraints+=[['rowid']]
    commands=[]
    for row in node.expression.expressions:
        require(len(row.expressions)==len(columns),'SQL_INSERT_ARITY')
        given=dict(zip(columns,row.expressions));conditions=[]
        for key in constraints:
            if all(c in given for c in key):
                conditions.append(exp.and_(*(exp.EQ(this=exp.column(c),expression=given[c].copy()) for c in key)))
        if conditions:
            commands.append((postgres(exp.Delete(this=table.copy(),where=exp.Where(this=exp.or_(*conditions)))),False))
        single=node.copy();single.set('expression',exp.Values(expressions=[row.copy()]))
        commands.append((postgres(single),True))
        require(len(commands)<=512,'ATOMIC_WRITES_COMMAND_LIMIT')
    return tuple(commands),True


_write_plan=lru_cache(maxsize=512)(_compile_write)


class Connection:
    def __init__(self, path, *, family, config, read_only=False, create=False, isolation_level=None):
        require(isinstance(family,str) and re.fullmatch(r'[a-z][a-z0-9_]{0,39}',family),'UNKNOWN_FAMILY')
        self.family=family
        self.config=config
        self.row_factory=None
        self.isolation_level=isolation_level
        self.total_changes=0
        self.lastrowid=None
        self._statement_number=0
        self._atomic_batch=False
        self._atomic_failed=False
        self.fts_limits=fts.Limits()
        self.session=None
        self._transaction_objects=None
        binding,key=binding_for(path,config)
        self.store_key=key
        try:
            self.session=Session(config,binding,read_only=read_only)
            self.session.open_store(key,family,create=create)
            self.raw=self.session.raw
            with self.raw.pipeline():
                self.raw.execute('SET search_path=pg_catalog,'+ident('orbita_'+family)+',orbita_common')
                catalogue=self.raw.execute('SELECT name,kind,source_sql,source_hash,definition FROM orbita_common.catalogue(%s)',(family,))
            items=catalogue.fetchall()
            self.catalog={name:dict(kind=kind,source=source,digest=digest,**definition) for name,kind,source,digest,definition in items}
            require(bool(self.catalog),'FAMILY_NOT_INSTALLED')
            self._read_catalogue=tuple(sorted((name,entry['kind'],tuple(c['name'] for c in entry['columns']) if entry['kind']=='table' else ())
                                              for name,entry in self.catalog.items()))
            self._write_catalogue=tuple(sorted((name,entry['kind'],
                tuple(c['name'] for c in entry.get('columns',[])),
                tuple(entry.get('primary',[])),tuple(tuple(k) for k in entry.get('unique',[])))
                for name,entry in self.catalog.items()))
        except BaseException:
            if self.session is not None:self.session.close()
            raise

    @property
    def in_transaction(self):return self.raw.info.transaction_status!=TransactionStatus.IDLE
    @property
    def closed(self):return self.session.closed

    def _table(self,table):
        name=_source_name(table)
        require(not table.catalog and not table.db,'SQL_QUALIFIED_TABLE_UNSUPPORTED')
        require(name=='sqlite_master' or name in self.catalog and self.catalog[name]['kind']=='table','SQL_TABLE_NOT_INSTALLED')
        table.set('this',exp.to_identifier(name))
        return name

    def _columns(self,name):
        if name=='sqlite_master':return ['name','type','sql']
        return [c['name'] for c in self.catalog[name]['columns']]

    def _select_stars(self,node):
        # Inner scopes are visited first. The hidden PostgreSQL scope key and
        # implicit rowid are never part of the historical SELECT * contract.
        for scope in traverse_scope(node):
            query=scope.expression
            if not isinstance(query,exp.Select):continue
            sources={}
            for alias,(_,source) in scope.selected_sources.items():
                if isinstance(source,exp.Table):sources[alias]=self._columns(self._table(source))
                else:sources[alias]=source.expression.named_selects
            projections=[]
            for field in query.expressions:
                if isinstance(field,exp.Star) or isinstance(field,exp.Column) and isinstance(field.this,exp.Star):
                    aliases=[field.table] if isinstance(field,exp.Column) and field.table else list(sources)
                    require(bool(aliases) and all(a in sources for a in aliases),'SQL_STAR_SOURCE')
                    for alias in aliases:projections.extend(exp.column(name,table=alias) for name in sources[alias])
                else:projections.append(field)
            query.set('expressions',projections)

    def _normalize(self,node):
        ctes={cte.alias for cte in node.find_all(exp.CTE)}
        for table in node.find_all(exp.Table):
            require(isinstance(table.this,exp.Identifier),'SQL_TABLE_FUNCTION_UNSUPPORTED')
            if table.name not in ctes:self._table(table)
        for column in node.find_all(exp.Column):
            if not isinstance(column.this,exp.Star):
                require(column.name.lower() not in ('_store_id','_index_ordinal'),'SQL_RESERVED_COLUMN')
                column.set('this',exp.to_identifier(column.name.lower()))
        self._select_stars(node)
        def change(item):
            if isinstance(item,(exp.JSONExtract,exp.JSONExtractScalar)):
                item.set('this',exp.Cast(this=item.this.copy(),to=exp.DataType.build('JSON')))
            elif isinstance(item,exp.Cast) and item.to.this in (exp.DataType.Type.VARBINARY,exp.DataType.Type.BINARY):
                # PostgreSQL's text->bytea cast interprets backslash escapes.
                # The application contract is the literal UTF-8 byte sequence.
                return exp.Anonymous(this='convert_to',expressions=[exp.Cast(this=item.this.copy(),to=exp.DataType.build('TEXT')),exp.Literal.string('UTF8')])
            elif isinstance(item,exp.Like):
                item.set('this',exp.Anonymous(this='orbita_common.ascii_fold',expressions=[item.this.copy()]))
                item.set('expression',exp.Anonymous(this='orbita_common.ascii_fold',expressions=[item.expression.copy()]))
            elif isinstance(item,exp.Is) and isinstance(item.this,exp.Placeholder) and isinstance(item.expression,exp.Null):
                # Untyped NULL used solely as a null test needs a server type.
                # Each occurrence is bound separately, so this does not cast a
                # numeric comparison/INSERT occurrence to text.
                item.set('this',exp.Cast(this=item.this.copy(),to=exp.DataType.build('TEXT')))
            return item
        return node.transform(change)

    def _fts_select(self,node,values):
        outer=not self.in_transaction
        if outer:self.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        cancelled=threading.Event()
        def cancel():
            cancelled.set()
            try:self.raw.cancel_safe(timeout=5)
            except psycopg.Error:pass
        timer=threading.Timer(self.fts_limits.seconds,cancel);timer.daemon=True
        try:
            require(self.raw.execute('SHOW transaction_isolation').fetchone()[0] in ('repeatable read','serializable'),'FTS_REPEATABLE_SNAPSHOT_REQUIRED')
            timer.start()
            with self.raw.transaction():
                node,values,budget=fts.resolve(self,node,dict(values),self.fts_limits)
                cursor=self._select(node,values);budget.check()
            if outer:self.raw.commit()
            return Cursor(self,cursor)
        except BaseException as error:
            if outer and not self.raw.closed:self.raw.rollback()
            if isinstance(error,psycopg.errors.QueryCanceled) and cancelled.is_set():
                raise StoreError('ORBITA_PG_FTS_DEADLINE') from None
            raise
        finally:
            timer.cancel()
            if timer.ident is not None:timer.join()

    def _bind_ddl(self,source):
        self.raw.execute('SELECT orbita_common.ensure_definition(%s,%s)',_definition_identity(self.family,source))
        return Cursor(self)

    def _compiled_reads_allowed(self):
        # An adapter overriding _send may need the AST for a fresh rewrite.
        # Such an adapter must explicitly opt in before receiving SQL text.
        return type(self)._send is Connection._send

    def _send(self,node,values):
        query=node if isinstance(node,str) else postgres(node)
        if values:
            # psycopg parses percent markers even inside SQL literals.
            query=query.replace('%','%%')
            query=re.sub(r'%%\((p\d+)\)s',r'%(\1)s',query)
            return self.raw.execute(query,values)
        return self.raw.execute(query)

    def _select(self,node,values):
        if self._atomic_batch:
            require(self.in_transaction,'ATOMIC_BATCH_TRANSACTION_LOST')
            return self._send(node,values)
        if not self.in_transaction:return self._send(node,values)
        self._statement_number+=1
        savepoint=ident('orbita_read_'+str(self._statement_number))
        try:
            # Keep statement-level recovery without three network round trips.
            # Cursor metadata is consumed only after the pipeline has synced.
            with self.raw.pipeline():
                self.raw.execute('SAVEPOINT '+savepoint)
                cursor=self._send(node,values)
                self.raw.execute('RELEASE SAVEPOINT '+savepoint)
            return cursor
        except BaseException:
            if not self.raw.closed:
                try:
                    self.raw.execute('ROLLBACK TO SAVEPOINT '+savepoint)
                    self.raw.execute('RELEASE SAVEPOINT '+savepoint)
                except psycopg.Error:pass  # Preserve the original error; never replay.
            raise

    def _prepare_insert(self,node):
        target=node.this
        table=target.this if isinstance(target,exp.Schema) else target
        name=self._table(table)
        meta=self.catalog[name]
        columns=[c.name.lower() for c in target.expressions] if isinstance(target,exp.Schema) else self._columns(name)
        require(all(c in self._columns(name) or c=='rowid' for c in columns),'SQL_INSERT_COLUMN')
        node.set('this',exp.Schema(this=table,expressions=[exp.to_identifier(c) for c in columns]))
        alternative=node.args.get('alternative')
        require(alternative in (None,'IGNORE','REPLACE'),'SQL_INSERT_CONFLICT_UNSUPPORTED')
        node.set('alternative',None)
        if alternative=='IGNORE':node.set('conflict',exp.OnConflict(action=exp.Var(this='DO NOTHING')))
        conflict=node.args.get('conflict')
        if conflict is not None and conflict.args.get('conflict_keys'):
            keys=[key.this if isinstance(key,exp.Ordered) else key for key in conflict.args['conflict_keys']]
            conflict.set('conflict_keys',[exp.column('_store_id'),*keys])
        supplied=node.args.get('returning')
        if supplied is not None:
            fields=[]
            for field in supplied.expressions:
                if isinstance(field,exp.Star) or isinstance(field,exp.Column) and isinstance(field.this,exp.Star):
                    fields.extend(exp.column(c) for c in self._columns(name))
                else:fields.append(field)
            supplied.set('expressions',fields)
        return table,meta,columns,alternative,supplied

    def _insert(self,node,values):
        table,meta,columns,alternative,supplied=self._prepare_insert(node)
        def inserted_id():
            serial,rowid=self.raw.execute('SELECT * FROM orbita_common.insert_status()').fetchone()
            return rowid if serial!=before_serial else self.lastrowid
        if alternative=='REPLACE':
            before_serial=self.raw.execute('SELECT serial FROM orbita_common.insert_status()').fetchone()[0]
            require(isinstance(node.expression,exp.Values),'SQL_REPLACE_VALUES_REQUIRED')
            require(supplied is None,'SQL_REPLACE_RETURNING_UNSUPPORTED')
            # A replacement deletes every conflicting row, then inserts a new
            # row. This deliberately runs FK actions and append-only triggers.
            count=0
            constraints=([meta['primary']] if meta['primary'] else [])+meta['unique']
            if 'rowid' in columns:constraints+=[['rowid']]
            for row in node.expression.expressions:
                require(len(row.expressions)==len(columns),'SQL_INSERT_ARITY')
                given=dict(zip(columns,row.expressions))
                conditions=[]
                for key in constraints:
                    if all(c in given for c in key):
                        conditions.append(exp.and_(*(exp.EQ(this=exp.column(c),expression=given[c].copy()) for c in key)))
                if conditions:
                    delete=exp.Delete(this=table.copy(),where=exp.Where(this=exp.or_(*conditions)))
                    self._send(delete,values).close()
                single=node.copy();single.set('expression',exp.Values(expressions=[row.copy()]))
                raw=self._send(single,values)
                count+=raw.rowcount
                raw.close()
            return Cursor(self,rowcount=count,lastrowid=inserted_id())
        # Serial-before, the actual INSERT and serial-after execute in order
        # on this connection and inside the caller's real transaction/savepoint.
        # A server failure aborts the pipeline; no status or RETURNING row is
        # consumed before synchronization and no command is replayed.
        with self.raw.pipeline():
            before=self.raw.execute('SELECT serial FROM orbita_common.insert_status()')
            raw=self._send(node,values)
            after=self.raw.execute('SELECT * FROM orbita_common.insert_status()')
        before_serial=before.fetchone()[0];serial,rowid=after.fetchone()
        before.close();after.close()
        last=rowid if serial!=before_serial else self.lastrowid
        if supplied is not None:return Cursor(self,raw,lastrowid=last)
        count=raw.rowcount;raw.close()
        return Cursor(self,rowcount=count,lastrowid=last)

    def execute_atomic_writes(self,writes):
        """Execute bounded mutations with no per-write result, or poison the batch.

        All members compile before SQL is sent. Constraints, triggers and RLS
        still run on every real statement. A failed or unknown outcome is never
        retried; the enclosing explicit atomic transaction must roll back.
        """
        cursors=[]
        try:
            require(not self.closed,'CONNECTION_CLOSED')
            require(not self._atomic_failed,'ATOMIC_BATCH_FAILED')
            require(self._atomic_batch,'ATOMIC_BATCH_REQUIRED')
            require(self.raw.info.transaction_status==TransactionStatus.INTRANS,'ATOMIC_BATCH_TRANSACTION_FAILED')
            require(not self.session.read_only,'READ_ONLY')
            require(type(self)._send is Connection._send and type(self)._normalize is Connection._normalize,'ATOMIC_WRITES_ADAPTER')
            require(isinstance(writes,(list,tuple)) and len(writes)<=128,'ATOMIC_WRITES_LIMIT')
            commands=[];has_insert=False
            for item in writes:
                require(isinstance(item,Mapping) and isinstance(item.get('sql'),str),'ATOMIC_WRITES_ENTRY')
                pieces=list(statements(item['sql']));require(len(pieces)==1,'SQL_ONE_STATEMENT_REQUIRED')
                parameters=item.get('params',())
                query,values=parameterize(pieces[0],dict(parameters) if isinstance(parameters,Mapping) else tuple(parameters))
                compile_plan=_write_plan if len(query)<=4096 else _compile_write
                plan,inserts=compile_plan(query,self.family,self._write_catalogue)
                has_insert=has_insert or inserts
                commands.extend((sql,values,count) for sql,count in plan)
                require(len(commands)<=512,'ATOMIC_WRITES_COMMAND_LIMIT')
            if not commands:return 0
            counts=[]
            with self.raw.pipeline():
                if has_insert:
                    before=self.raw.execute('SELECT serial FROM orbita_common.insert_status()');cursors.append(before)
                for sql,values,count in commands:
                    cursor=self._send(sql,values);cursors.append(cursor)
                    if count:counts.append(cursor)
                if has_insert:
                    after=self.raw.execute('SELECT * FROM orbita_common.insert_status()');cursors.append(after)
            # No metadata is trusted before the whole pipeline synchronizes.
            changes=sum(max(cursor.rowcount,0) for cursor in counts)
            last=self.lastrowid
            if has_insert:
                prior=before.fetchone();current=after.fetchone()
                require(prior is not None and current is not None,'ATOMIC_WRITES_INSERT_STATUS')
                serial,rowid=current
                if serial!=prior[0]:last=rowid
            self.total_changes+=changes;self.lastrowid=last
            return len(writes)
        except BaseException:
            self.fail_atomic_batch()
            raise
        finally:
            for cursor in cursors:cursor.close()

    def fail_atomic_batch(self):
        # Client-side conversion can fail after PostgreSQL accepted a write.
        # Such a batch may only roll back or close; it must never commit.
        if self._atomic_batch:self._atomic_failed=True

    def begin_atomic_batch(self):
        """Opt in to whole-batch rollback, retaining ordinary SQL by default."""
        try:
            require(not self.closed,'CONNECTION_CLOSED')
            require(not self._atomic_failed,'ATOMIC_BATCH_FAILED')
            require(not self.session.read_only,'READ_ONLY')
            require(not self._atomic_batch and not self.in_transaction,'TRANSACTION_ALREADY_ACTIVE')
            self._atomic_batch=True
            # The existing store lock is acquired once for this transaction.
            # Every statement still runs its normal live authority/RLS checks.
            self.session.begin(immediate=True)
        except BaseException:
            self.fail_atomic_batch()
            raise

    def execute(self,source,parameters=()):
        try:
            if self._atomic_failed:
                pieces=list(statements(source))
                if len(pieces)==1 and not parameters and isinstance(parse(pieces[0]),exp.Rollback):
                    self.rollback();return Cursor(self)
                raise StoreError('ORBITA_PG_ATOMIC_BATCH_FAILED')
            return self._execute(source,parameters)
        except BaseException:
            self.fail_atomic_batch()
            raise

    def _execute(self,source,parameters=()):
        require(not self.closed,'CONNECTION_CLOSED')
        pieces=list(statements(source))
        require(len(pieces)==1,'SQL_ONE_STATEMENT_REQUIRED')
        source=pieces[0]
        if re.match(r'^\s*CREATE\b',source,re.I):
            require(not parameters,'SQL_DDL_PARAMETERS')
            with self.raw.transaction():return self._bind_ddl(source)
        query,values=parameterize(source,dict(parameters) if isinstance(parameters,Mapping) else tuple(parameters))
        if self._compiled_reads_allowed() and len(query)<=4096 and re.match(r'^\s*(SELECT|WITH)\b',query,re.I):
            compiled=_read_plan(query,self.family,self._read_catalogue)
            if compiled is not None:return Cursor(self,self._select(compiled,values))
        elif type(self)._normalize is Connection._normalize and len(query)<=4096 and re.match(r'^\s*(SELECT|WITH)\b',query,re.I):
            # An adapter may require a mutable AST for a fresh source filter.
            # Reuse only the immutable normalized syntax, never a rewritten
            # tree, parameter, result, selection or authorization decision.
            template=_read_tree(query,self.family,self._read_catalogue)
            if template is not None:
                tree=template.copy()
                if tree.find(exp.Match) is not None:return self._fts_select(tree,values)
                return Cursor(self,self._select(tree,values))
        tree=parse(query)
        if isinstance(tree,exp.Transaction):
            require(not self.in_transaction,'TRANSACTION_ALREADY_ACTIVE')
            self.session.begin(immediate=tree.this in ('IMMEDIATE','EXCLUSIVE'))
            return Cursor(self)
        if isinstance(tree,exp.Commit):self.commit();return Cursor(self)
        if isinstance(tree,exp.Rollback):self.rollback();return Cursor(self)
        # PRAGMA/integrity checks belong to the old engine. Consumers must use
        # the real PostgreSQL checks, never a fabricated SQLite success row.
        require(isinstance(tree,(exp.Select,exp.Union,exp.Insert,exp.Update,exp.Delete)),'SQL_STATEMENT_UNSUPPORTED')
        mutation=isinstance(tree,(exp.Insert,exp.Update,exp.Delete))
        require(not mutation or not self.session.read_only,'READ_ONLY')
        tree=self._normalize(tree)
        if tree.find(exp.Match) is not None:
            require(not mutation,'FTS_READ_QUERY_REQUIRED')
            return self._fts_select(tree,values)
        if mutation and self.isolation_level is not None and not self.in_transaction:self.session.begin()
        if not mutation:
            # PostgreSQL already gives a single autocommit statement an atomic
            # snapshot. An explicit BEGIN/COMMIT adds no protection here.
            return Cursor(self,self._select(tree,values))
        # A failed statement rolls back to its savepoint; it does not silently
        # discard earlier successful statements in the caller's transaction.
        if self._atomic_batch:
            require(self.in_transaction,'ATOMIC_BATCH_TRANSACTION_LOST')
            cursor=self._insert(tree,values) if isinstance(tree,exp.Insert) else Cursor(self,self._send(tree,values))
        else:
            with self.raw.transaction():
                self.raw.execute("SELECT pg_advisory_xact_lock(hashtextextended('store:' || orbita_common.store_id()::text,0))")
                cursor=self._insert(tree,values) if isinstance(tree,exp.Insert) else Cursor(self,self._send(tree,values))
        if mutation:
            self.total_changes+=max(cursor.rowcount,0)
            if isinstance(tree,exp.Insert) and cursor.lastrowid is not None:self.lastrowid=cursor.lastrowid
        return cursor

    def executemany(self,source,parameters):
        try:
            count=0;last=None
            for row in parameters:
                cur=self.execute(source,row);count+=max(cur.rowcount,0);last=cur.lastrowid;cur.close()
            return Cursor(self,rowcount=count,lastrowid=last)
        except BaseException:
            self.fail_atomic_batch()
            raise

    def nearest_vectors(self,query,limit=100,*,limits=None):
        from .vectors import nearest
        return Cursor(self,rows=nearest(self,query,limit,limits=limits),names=('rowid','distance'))

    def logical_manifest(self,*,limits=None):
        from .manifests import manifest
        return manifest(self,limits=limits)

    def table_columns(self,name):
        require(name in self.catalog and self.catalog[name]['kind']=='table','SQL_TABLE_NOT_INSTALLED')
        columns=self._columns(name)
        with self.raw.execute('SELECT '+','.join(map(ident,columns))+' FROM '+ident(name)+' LIMIT 0') as cursor:
            return [c.name for c in cursor.description]

    def executescript(self,source):
        try:
            if self._atomic_failed:return self.execute(source)
            return self._executescript(source)
        except BaseException:
            self.fail_atomic_batch()
            raise

    def _executescript(self,source):
        pieces=list(statements(source))
        if pieces and all(re.match(r'^\s*CREATE\b',piece,re.I) for piece in pieces):
            identities=[_definition_identity(self.family,piece) for piece in pieces]
            with self.raw.transaction():
                # Every entry is still checked by the server for this session.
                # A rejected member rolls back the whole initialization batch.
                self.raw.execute('SELECT orbita_common.ensure_definitions(%s::text[],%s::text[])',
                                 ([name for name,digest in identities],[digest for name,digest in identities])).close()
        else:
            for statement in pieces:self.execute(statement).close()
        return Cursor(self)

    def begin_consistent_write(self):
        require(not self.closed,'CONNECTION_CLOSED')
        require(not self.session.read_only,'READ_ONLY')
        require(not self.in_transaction,'TRANSACTION_ALREADY_ACTIVE')
        try:
            self.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ')
            self.raw.execute("SELECT pg_advisory_xact_lock(hashtextextended('store:' || orbita_common.store_id()::text,0))")
        except BaseException:
            if not self.raw.closed:self.raw.rollback()
            raise

    def transaction_objects(self,path):
        """Objects of this store's parent, sharing the exact row transaction."""
        require(not self.closed,'CONNECTION_CLOSED')
        require(not self.session.read_only,'READ_ONLY')
        require(self.in_transaction,'OBJECT_TRANSACTION_REQUIRED')
        require(self.raw.execute('SHOW transaction_isolation').fetchone()[0]=='repeatable read',
                'OBJECT_REPEATABLE_TRANSACTION_REQUIRED')
        binding,key=binding_for(path,self.config)
        require(binding==self.session.binding,'OBJECT_TRANSACTION_BINDING_MISMATCH')
        parent=self.store_key.rpartition('/')[0]
        require(bool(parent) and (key==parent or key.startswith(parent+'/')),'OBJECT_TRANSACTION_PATH_ESCAPE')
        if self._transaction_objects is None:
            from .objects import ObjectStore
            self._transaction_objects=ObjectStore.borrow(self)
        return self._transaction_objects,key

    def _close_transaction_objects(self):
        store=self._transaction_objects
        self._transaction_objects=None
        if store is not None:store.close()

    def commit(self):
        try:
            require(not self.closed,'CONNECTION_CLOSED')
            require(not self._atomic_failed,'ATOMIC_BATCH_FAILED')
            if self._atomic_batch:
                require(self.raw.info.transaction_status==TransactionStatus.INTRANS,'ATOMIC_BATCH_TRANSACTION_FAILED')
            require(self._transaction_objects is None or not self._transaction_objects.handles,
                    'OBJECT_TRANSACTION_OPEN_HANDLES')
            self._close_transaction_objects()
            self.raw.commit()
        except BaseException:
            self.fail_atomic_batch()
            raise
        self._atomic_batch=False;self._atomic_failed=False

    def rollback(self):
        require(not self.closed,'CONNECTION_CLOSED')
        try:
            try:self._close_transaction_objects()
            finally:self.raw.rollback()
        except BaseException:
            # An unconfirmed rollback must not re-enable commit.
            self.fail_atomic_batch()
            raise
        self._atomic_batch=False;self._atomic_failed=False

    def close(self):
        try:self._close_transaction_objects()
        finally:self.session.close()

    def interrupt(self):
        require(not self.closed,'CONNECTION_CLOSED')
        self.raw.cancel_safe(timeout=5)

    @contextmanager
    def transaction(self,*,immediate=False):
        outer=not self.in_transaction
        if outer:self.session.begin(immediate=immediate)
        try:
            with self.raw.transaction():yield self
            if outer:self.commit()
        except BaseException:
            if outer and not self.raw.closed:self.rollback()
            raise

    def __enter__(self):
        if not self.in_transaction:self.session.begin()
        return self

    def __exit__(self,kind,*unused):
        if kind is None:self.commit()
        else:self.rollback()
