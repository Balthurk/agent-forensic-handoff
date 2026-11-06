"""Semantic consumers of the one common database, with no legacy fallback."""
from sqlglot import exp, parse_one
from functools import lru_cache

from orbita_store.config import read_config, require
from orbita_store.connection import Connection as CommonConnection, Cursor, Row


@lru_cache(maxsize=128)
def _selected_relation(fields,selected_parameter):
    # Syntax only. Every use copies the tree and binds the current selection.
    return parse_one('SELECT '+fields+' FROM orbita_semantic.record_versions r '
        'WHERE EXISTS(SELECT 1 FROM orbita_semantic.record_versions seed '
        "CROSS JOIN LATERAL json_array_elements(seed.payload::json->'source_refs') ref "
        'WHERE seed.record_id=r.record_id AND seed._store_id=r._store_id '
        "AND ref->>'id'=ANY(%("+selected_parameter+')s::text[]))',read='postgres')


class Connection(CommonConnection):
    postgres=True
    def __init__(self,path,*,family,read_only=False):
        super().__init__(path,family=family,config=read_config(),read_only=read_only,
                         create=not read_only,isolation_level='')
        self.read_only=read_only
        self.row_factory=Row
        self.selected_sources=None
        self.integrity_batch=None

    def restrict_sources(self,sources):
        require(self.family=='semantic' and self.selected_sources is None,'ALREADY_RESTRICTED')
        values=list(sources)
        require(len(values)<=20000 and all(isinstance(v,str) for v in values),'SOURCE_SELECTION_LIMIT')
        self.selected_sources=values

    def _compiled_reads_allowed(self):
        # Selection is current per connection. Restricted reads must retain
        # their AST so _send can select whole lineages under that selection.
        return type(self)._send is Connection._send and self.selected_sources is None

    def _send(self,node,values):
        if self.selected_sources is not None:
            require(isinstance(node,(exp.Select,exp.Union)),'RESTRICTED_SESSION_MUTATION')
            node=node.copy();values=dict(values)
            selected_parameter='p'+str(max([int(k[1:]) for k in values]+[-1])+1)
            tables=[t for t in node.find_all(exp.Table) if t.name=='record_versions']
            if tables:values[selected_parameter]=self.selected_sources
            for table in tables:
                # Select whole lineages, including later revisions that no
                # longer mention a selected source. Never resurrect old heads.
                fields=','.join('r.'+c for c in ['rowid',*self._columns('record_versions')])
                query=_selected_relation(fields,selected_parameter).copy()
                table.replace(exp.Subquery(this=query,alias=exp.TableAlias(this=exp.to_identifier(table.alias_or_name))))
        return super()._send(node,values)

    def prefetch_integrity(self,rows):
        from .integrity_batch import IntegrityBatch
        self.integrity_batch=IntegrityBatch.build(self,rows)

    def execute(self,source,parameters=()):
        check=getattr(self,'_read_budget_check',None)
        if check:check()
        try:return self._execute_checked(source,parameters)
        finally:
            if check:check()

    def _execute_checked(self,source,parameters=()):
        normalized=source.strip().rstrip(';')
        if normalized.upper() in ('BEGIN','BEGIN IMMEDIATE','COMMIT','ROLLBACK'):
            self.integrity_batch=None
        if self.integrity_batch is not None and self.read_only and self.in_transaction:
            cached=self.integrity_batch.lookup(normalized,parameters)
            if cached is not None:
                names=list(cached[0]) if cached else []
                return Cursor(self,rows=[tuple(row[name] for name in names) for row in cached],names=names)
        return super().execute(source,parameters)

    def commit(self):
        self.integrity_batch=None
        super().commit()
    def rollback(self):
        self.integrity_batch=None
        super().rollback()


def connect(path,*,family,read_only=False):return Connection(path,family=family,read_only=read_only)


def restrict_sources(records,*,bounded_diagnostics=False):
    # The original bounded-store contract reports each excluded lineage.
    # Restrict only above its 5,000-row budget; this fresh bounded query is
    # never cached and does not override current source/envelope validation.
    if bounded_diagnostics and len(records.db.execute('SELECT record_id FROM record_versions LIMIT 5001').fetchall())<=5000:return
    records.db.restrict_sources(records.memory.sources)
    records.selection_restricted=True
