"""Qualification-only workspaces. Never imported by application code.

Fixture data stays enumerated until its verification/cleanup receipt. The
operator is used only to provision isolated test scopes and inject declared
corruption; the application always receives the unprivileged runtime role.
"""
from pathlib import Path
from contextlib import closing, contextmanager
import json
import os
import uuid
from psycopg import sql

from orbita_store.admin import connect_operator,provision_workspace

ACTIVE={}


def connect_semantic(path):
    from afh_semantic.common_backend import connect
    return connect(path,family='semantic')


def corrupt_path(path,table,values):
    with closing(connect_semantic(path)) as connection:
        ACTIVE[connection.session.binding.workspace_id].corrupt(connection,table,values)


@contextmanager
def temporary_corruption(path,table,values):
    with closing(connect_semantic(path)) as connection:
        fixture=ACTIVE[connection.session.binding.workspace_id]
        assert table in connection.catalog and all(k in connection._columns(table) for k in values)
        rows=connection.execute('SELECT rowid,'+','.join(values)+' FROM '+table+' ORDER BY rowid').fetchall()
        fixture.corrupt(connection,table,values)
        try:yield
        finally:
            for row in rows:fixture.corrupt(connection,table,dict(zip(values,tuple(row)[1:])),where_rowid=row[0])
            restored=connection.execute('SELECT rowid,'+','.join(values)+' FROM '+table+' ORDER BY rowid').fetchall()
            assert [tuple(row) for row in restored]==[tuple(row) for row in rows]


class WorkspaceFixture:
    def __init__(self,label):
        self.operator=json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_OPERATOR_CONFIG']).read_text(encoding='utf8'))
        config=json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_CONFIG']).read_text(encoding='utf8'))
        self.id=str(uuid.uuid4())
        value=provision_workspace(self.operator,label='qualification:'+self.id+':'+label,kind='test')
        self.workspace_id=value['workspaceId']
        self.name=str(Path(os.environ['ORBITA_POSTGRES_TEST_ROOT'])/self.id)
        self.previous={key:os.environ.get(key) for key in ('ORBITA_POSTGRES_CONFIG','ORBITA_POSTGRES_BINDING')}
        siblings=json.loads(self.previous['ORBITA_POSTGRES_BINDING'])['bindings'] if self.previous['ORBITA_POSTGRES_BINDING'] else []
        assert all(b['workspaceId'] in ACTIVE for b in siblings)
        config['bindings']=[*siblings,dict(root=self.name,**value)]
        ACTIVE[self.workspace_id]=self
        os.environ.pop('ORBITA_POSTGRES_CONFIG',None)
        os.environ['ORBITA_POSTGRES_BINDING']=json.dumps(config)
        self.receipt=Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS'])/('fixture-'+self.id+'.json')
        self.receipt.write_text(json.dumps(dict(instanceId=config['instanceId'],workspaceId=self.workspace_id,
            label=label,root=self.name,corruptions=[]),indent=2),encoding='utf8')

    def corrupt(self,connection,table,values,*,where_rowid=None):
        assert connection.session.binding.workspace_id==self.workspace_id
        assert table in connection.catalog and values and all(k in connection._columns(table) for k in values)
        assert not connection.in_transaction
        with connect_operator(self.operator) as raw, raw.transaction():
            scope=raw.execute('SELECT w.kind,w.label FROM orbita_private.workspaces w JOIN orbita_private.stores s ON s.workspace_id=w.id WHERE s.id=%s::uuid AND w.id=%s::uuid',(connection.session.store_id,self.workspace_id)).fetchone()
            assert scope and scope[0]=='test' and scope[1].startswith('qualification:'+self.id+':')
            # The failure fixture deliberately bypasses immutability under the
            # operator, for one exact test store, inside this transaction only.
            raw.execute("SET LOCAL session_replication_role='replica'")
            statement=sql.SQL('UPDATE {}.{} SET {} WHERE _store_id=%s::uuid').format(
                sql.Identifier('orbita_'+connection.family),sql.Identifier(table),
                sql.SQL(',').join(sql.SQL('{}=%s').format(sql.Identifier(k)) for k in values))
            parameters=[*values.values(),connection.session.store_id]
            if where_rowid is not None:
                statement+=sql.SQL(' AND rowid=%s');parameters.append(where_rowid)
            count=raw.execute(statement,parameters).rowcount
            assert count>0
        receipt=json.loads(self.receipt.read_text(encoding='utf8'))
        receipt['corruptions'].append(dict(storeId=connection.session.store_id,table=table,fields=list(values),rows=count))
        self.receipt.write_text(json.dumps(receipt,indent=2),encoding='utf8')

    def cleanup(self):
        ACTIVE.pop(self.workspace_id,None)
        for key,value in self.previous.items():
            if value is None:os.environ.pop(key,None)
            else:os.environ[key]=value
        assert not Path(self.name).exists(),'OPERATIONAL_DATA_CREATED_ON_LOCAL_DISK'
