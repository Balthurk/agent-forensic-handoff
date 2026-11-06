"""Derived managed locators. Unknown children never fall into a parent store."""
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
import os
import psycopg

from . import StoreError
from .config import Binding, binding_for, plain_local_path, require
from .connection import Connection


# Only these literal, reviewed server diagnostics cross the bridge. Never
# forward arbitrary PostgreSQL details, which may contain source or secrets.
ERROR_CODES=frozenset('ORBITA_PG_'+name for name in (
    'CONTROL_AUTHORITY_REQUIRED','MANAGED_ID','MANAGED_OWNER_REQUIRED','MANAGED_PURGED',
    'MANAGED_INITIAL_POLICY','MANAGED_MODE','MANAGED_UNKNOWN','MANAGED_INACTIVE',
    'MANAGED_PURGE_NOT_PREPARED','MANAGED_LIVE_CONSUMER','PURGE_FRESH_AUTHORITY_REQUIRED','MANAGED_ARCHIVE_BINDING'))


def query(db,statement,params=()):
    try:return db.raw.execute(statement,params).fetchone()[0]
    except psycopg.Error as error:
        if error.diag.message_primary in ERROR_CODES:raise StoreError(error.diag.message_primary) from None
        raise


class ManagedPurged(StoreError):
    def __init__(self):super().__init__('ORBITA_PG_MANAGED_PURGED')


class ManagedBindings:
    def __init__(self,bridge):self.bridge=bridge;self.controls={}

    @contextmanager
    def control(self,entry):
        db=entry['database'];owned=db.closed
        if owned:db=Connection(entry['path'],family='access',config=entry['config'])
        try:
            require(not db.in_transaction,'MANAGED_UNCOMMITTED_CONTENT')
            yield db
        finally:
            if owned:db.close()

    def register(self,db):
        require(db.family=='access' and not db.in_transaction,'MANAGED_CONTROL_CONNECTION')
        identity=query(db,'SELECT orbita_common.managed_control()')
        path=plain_local_path(db.bridge_path);prefix=path.parent/'spaces';key=os.path.normcase(str(prefix))
        prior=self.controls.get(key)
        require(prior is None or prior['identity']==identity,'MANAGED_CONTROL_IDENTITY_CHANGED')
        if prior is not None and not prior['database'].closed:return identity
        self.controls[key]=dict(prefix=prefix,path=str(path),config=db.config,database=db,identity=identity)
        return identity

    def entry(self,db):
        matches=[entry for entry in self.controls.values() if entry['identity']['storeId']==db.session.store_id]
        require(len(matches)==1,'MANAGED_CONTROL_NOT_REGISTERED')
        return matches[0]

    def config_for(self,path):
        if not self.controls:return
        # Fresh native ancestor checks and lexical traversal rejection precede
        # every resolution. Capability cache entries carry no cached authority.
        binding_for(path,self.bridge.config)
        value=plain_local_path(path)
        for entry in sorted(self.controls.values(),key=lambda e:len(e['prefix'].parts),reverse=True):
            try:relative=value.relative_to(entry['prefix'])
            except ValueError:continue
            require(bool(relative.parts),'MANAGED_RESERVED_PREFIX')
            local=relative.parts[0]
            with self.control(entry) as db:
                state=query(db,"SELECT orbita_common.managed_binding(%s,'state')",(local,))
                if state['purged']:raise ManagedPurged()
                root=str(entry['prefix']/local)
                existing=next((b for b in self.bridge.config.bindings if os.path.normcase(b.root)==os.path.normcase(root)),None)
                if existing is not None:
                    require(existing.workspace_id==state['workspaceId'],'MANAGED_CHILD_IDENTITY_CHANGED')
                else:
                    details=query(db,"SELECT orbita_common.managed_binding(%s,'maintenance')",(local,))
                    child=Binding(root,details['workspaceId'],details['capability'])
                    self.bridge.config=replace(self.bridge.config,bindings=(*self.bridge.config.bindings,child))
            return

    def close_idle_child(self,workspace):
        b=self.bridge
        busy=any(not db.closed and db.session.binding.workspace_id==workspace for db in b.databases.values())
        busy=busy or any(not t.closed and t.connection.session.binding.workspace_id==workspace for t in b.transfers.values())
        busy=busy or any(not lease.closed and lease.session.binding.workspace_id==workspace for lease in b.leases.values())
        busy=busy or any(store.handles for (identity,_),store in b.stores.items() if identity==workspace)
        require(not busy,'MANAGED_OWNED_CONSUMER_BUSY')
        for key,store in list(b.stores.items()):
            if key[0]==workspace:
                store.close();del b.stores[key]

    def worker_configuration(self,path):
        # A control's derived maintenance binding must never be delegated to
        # query processes. Resolve a fresh active worker epoch instead.
        binding_for(path,self.bridge.config)
        value=plain_local_path(path)
        for entry in sorted(self.controls.values(),key=lambda e:len(e['prefix'].parts),reverse=True):
            try:relative=value.relative_to(entry['prefix'])
            except ValueError:continue
            require(bool(relative.parts),'MANAGED_RESERVED_PREFIX')
            with self.control(entry) as db:
                details=query(db,"SELECT orbita_common.managed_binding(%s,'worker')",(relative.parts[0],))
            return dict(schema=1,**self.bridge.config.connection_parameters(),instanceId=self.bridge.config.instance_id,
                        bindings=[dict(root=str(entry['prefix']/relative.parts[0]),
                                       workspaceId=details['workspaceId'],capability=details['capability'])])

    def call(self,request):
        db=self.bridge.databases[request['dbId']];action=request['op'][8:]
        if action=='register':return dict(control=self.register(db))
        entry=self.entry(db);local=request['localId']
        if action=='provision':
            require(db.in_transaction,'MANAGED_CREATE_TRANSACTION_REQUIRED')
            return dict(result=query(db,'SELECT orbita_common.provision_managed(%s)',(local,)))
        require(not db.in_transaction,'MANAGED_UNCOMMITTED_CONTENT')
        if action=='state':return dict(state=query(db,"SELECT orbita_common.managed_binding(%s,'state')",(local,)))
        if action=='legacy-archive':
            return dict(binding=query(db,'SELECT orbita_common.managed_legacy_archive(%s,%s)',(local,request['archiveId'])))
        if action=='worker-config':
            value=query(db,"SELECT orbita_common.managed_binding(%s,'worker')",(local,))
            config=self.bridge.config
            # One original child root: rebasing to its data subdirectory would
            # silently change every existing logical key in this workspace.
            worker=dict(schema=1,**config.connection_parameters(),instanceId=config.instance_id,
                        bindings=[dict(root=str(entry['prefix']/local),workspaceId=value['workspaceId'],capability=value['capability'])])
            return dict(configuration=worker,epoch=value['epoch'])
        if action in ('purge','drain'):
            value=query(db,"SELECT orbita_common.managed_binding(%s,'state')",(local,))
            self.close_idle_child(value['workspaceId'])
            if action=='drain':return dict(consumers=query(db,'SELECT orbita_common.managed_consumers(%s)',(local,)))
            return dict(result=query(db,'SELECT orbita_common.purge_managed(%s)',(local,)))
        raise StoreError('ORBITA_PG_MANAGED_OPERATION_UNSUPPORTED')
