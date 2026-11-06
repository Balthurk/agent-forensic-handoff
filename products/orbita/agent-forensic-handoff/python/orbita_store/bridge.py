"""Owned UTF-8 pipe bridge. Configuration is explicit; SQL never falls back."""
import base64
import errno
from datetime import date,datetime
from decimal import Decimal
import json
import math
import os
import sys

import psycopg

from . import StoreError
from .config import read_config,binding_for,require,parse_config
from .connection import Connection,Row
from .objects import ObjectStore,BLOCK
from .leases import StoreLease
from .transfers import StoreExport,import_object
from .managed import ManagedBindings,ManagedPurged
from psycopg.types.json import Jsonb

MAX_REQUEST=8*1024*1024
MAX_RESPONSE=32*1024*1024


def encode(value,*,bigints=False):
    if isinstance(value,Decimal):
        require(value.is_finite(),'NUMERIC_NONFINITE')
        # SUM(bigint) returns PostgreSQL numeric. Keep integral aggregates
        # exact through the existing integer/BigInt protocol, never float.
        if value==value.to_integral_value():return encode(int(value),bigints=bigints)
        number=float(value)
        # A fractional numeric is accepted only if IEEE-754 retains it exactly.
        # Callers wanting approximation must explicitly CAST their SQL to REAL.
        require(math.isfinite(number) and Decimal.from_float(number)==value,'NUMERIC_PRECISION_UNSUPPORTED')
        return number
    if type(value) is float:require(math.isfinite(value),'NUMERIC_NONFINITE')
    if isinstance(value,(bytes,bytearray,memoryview)):return {'__bytes__':base64.b64encode(value).decode('ascii')}
    if isinstance(value,(datetime,date)):return value.isoformat()
    if type(value) is int and (bigints or abs(value)>2**53-1):return {'__integer__':str(value)}
    if isinstance(value,dict):return {k:encode(v,bigints=bigints) for k,v in value.items()}
    if isinstance(value,(tuple,list)):return [encode(v,bigints=bigints) for v in value]
    return value


def decode(value):
    if isinstance(value,dict):
        if set(value)=={'__bytes__'}:return base64.b64decode(value['__bytes__'],validate=True)
        if set(value)=={'__integer__'}:return int(value['__integer__'])
        return {k:decode(v) for k,v in value.items()}
    if isinstance(value,list):return [decode(v) for v in value]
    return value


class Bridge:
    def __init__(self):
        self.config=read_config();self.databases={};self.stores={};self.files={};self.leases={};self.transfers={};self.next_id=1
        self.managed=ManagedBindings(self)

    def allocate(self,collection,value):
        id=self.next_id;self.next_id+=1;collection[id]=value;return id

    def object_store(self,path,*,read_only=False):
        binding,key=binding_for(path,self.config);identity=(binding.workspace_id,read_only)
        if identity not in self.stores:self.stores[identity]=ObjectStore(self.config,binding,read_only=read_only)
        return self.stores[identity],key

    def fail_request(self,request):
        if isinstance(request,dict) and type(request.get('dbId')) is int:
            db=self.databases.get(request['dbId'])
            if db is not None:db.fail_atomic_batch()

    def call(self,request):
        try:return self._call(request)
        except BaseException:
            self.fail_request(request)
            raise

    def _call(self,request):
        operation=request['op']
        if operation.startswith('managed.'):return self.managed.call(request)
        # All path operands must resolve before any side effect. Checking just
        # a source would allow an unknown target child to fall into its parent.
        for field in ('path','source','target','base'):
            if field in request:
                try:self.managed.config_for(request[field])
                except ManagedPurged:
                    if operation=='object.exists' and field=='path':return dict(exists=False)
                    raise
        if operation=='worker-configuration':
            configuration=self.managed.worker_configuration(request['path'])
            if configuration is None:
                binding,_=binding_for(request['path'],self.config)
                configuration=dict(schema=1,**self.config.connection_parameters(),instanceId=self.config.instance_id,
                    bindings=[dict(root=binding.root,workspaceId=binding.workspace_id,capability=binding.capability)])
            from .session import Session
            config=parse_config(configuration)
            with Session(config,config.bindings[0],read_only=True) as authority:
                require(authority.raw.execute('SELECT orbita_common.worker_delegation_allowed()').fetchone()[0],
                        'WORKER_DELEGATION_DENIED')
            return dict(configuration=configuration)
        if operation=='worker-observe':
            from .ownership import observe_owner
            return dict(consumers=observe_owner(self.config,request['ownerId']))
        if operation=='health':
            from pathlib import Path
            from .session import Session
            if request.get('path') is not None:binding,_=binding_for(request['path'],self.config)
            else:
                require(len(self.config.bindings)==1,'HEALTH_ROOT_REQUIRED');binding=self.config.bindings[0]
            with Session(self.config,binding,read_only=True) as probe:
                probe.begin()
                version=int(probe.raw.execute('SHOW server_version_num').fetchone()[0])
                settings={name:probe.raw.execute('SHOW '+name).fetchone()[0] for name in ('fsync','full_page_writes','synchronous_commit')}
                families=sorted(p.stem for p in Path(__file__).with_name('schemas').glob('*.sql'))
                installed={family:probe.raw.execute('SELECT count(*) FROM orbita_common.catalogue(%s)',(family,)).fetchone()[0] for family in families}
                require(version>=160000 and all(value=='on' for value in settings.values()),'HEALTH_DURABILITY')
                require(bool(installed) and all(installed.values()),'HEALTH_FAMILY_MISSING')
                return dict(health=dict(instanceId=self.config.instance_id,database=self.config.dbname,workspaceId=binding.workspace_id,
                    workspaceKind=probe.raw.execute('SELECT orbita_common.workspace_kind()').fetchone()[0],role='orbita_runtime',privileged=False,serverVersion=version,pythonVersion=sys.version.split()[0],settings=settings,families=installed,readOnly=True))
        if operation=='transfer.open':
            value=StoreExport(request['path'],config=self.config)
            return dict(transferId=self.allocate(self.transfers,value),info=value.info)
        if operation=='transfer.read':
            return dict(bytes=self.transfers[request['transferId']].read(request['length']))
        if operation=='transfer.close':
            self.transfers.pop(request['transferId']).close();return dict()
        if operation=='transfer.import':
            return dict(result=import_object(request['source'],request['offset'],request['length'],request['path'],config=self.config,
                expected_object_id=request.get('expectedObjectId'),expected_revision=request.get('expectedRevision')))
        if operation.startswith('restore.'):
            action=operation[8:];store,key=self.object_store(request['path'],read_only=action=='state')
            if action=='state':return dict(state=store.raw.execute('SELECT orbita_common.restore_state(%s)',(key,)).fetchone()[0])
            if action=='prepare':return dict(state=store.raw.execute('SELECT orbita_common.prepare_restore(%s,%s)',(key,Jsonb(request['state']))).fetchone()[0])
            if action=='activate':
                require(type(request['automaticWork']) is bool and type(request['externalAccess']) is bool,'RESTORE_ACTIVATION_FLAGS')
                return dict(state=store.raw.execute('SELECT orbita_common.activate_restore(%s,%s,%s,%s)',
                    (key,request['restoreId'],request['automaticWork'],request['externalAccess'])).fetchone()[0])
            raise StoreError('ORBITA_PG_RESTORE_OPERATION_UNSUPPORTED')
        if operation=='lease.acquire':
            lease=StoreLease(request['path'],config=self.config,mode=request['mode'],
                             own_shared=self.leases[request['ownLeaseId']] if request.get('ownLeaseId') is not None else None)
            return dict(leaseId=self.allocate(self.leases,lease),token=lease.token)
        if operation=='lease.release':
            lease=self.leases.pop(request['leaseId']);lease.close();return dict()
        if operation=='open':
            db=Connection(request['path'],family=request['family'],config=self.config,
                          read_only=bool(request.get('readOnly')),create=bool(request.get('create')))
            db.bridge_path=str(request['path'])
            db.row_factory=Row
            return dict(dbId=self.allocate(self.databases,db))
        if operation=='close':
            db=self.databases.pop(request['dbId'])
            try:db.close();return dict()
            finally:self.files={id:handle for id,handle in self.files.items() if not handle.closed}
        if operation=='exec':
            try:self.databases[request['dbId']].executescript(request['sql']).close();return dict()
            finally:self.files={id:handle for id,handle in self.files.items() if not handle.closed}
        if operation=='atomic-writes':
            return dict(completed=self.databases[request['dbId']].execute_atomic_writes(decode(request['writes'])))
        if operation=='begin-atomic-batch':
            self.databases[request['dbId']].begin_atomic_batch();return dict()
        if operation=='fail-atomic-batch':
            self.databases[request['dbId']].fail_atomic_batch();return dict()
        if operation=='begin-consistent-write':
            self.databases[request['dbId']].begin_consistent_write();return dict()
        if operation.startswith('transaction-object.'):
            store,key=self.databases[request['dbId']].transaction_objects(request['path'])
            action=operation[len('transaction-object.'):]
            if action=='mkdir':store.mkdir(key,parents=bool(request.get('recursive')),exist_ok=bool(request.get('existOk')));return dict()
            require(action=='open','OBJECT_TRANSACTION_OPERATION_UNSUPPORTED')
            mode=request.get('mode','r')
            require(mode in ('r','w','x'),'FILE_MODE')
            handle=store.open_read(key) if mode=='r' else store.open_write(key,exclusive=mode=='x')
            return dict(fileId=self.allocate(self.files,handle))
        if operation=='nearest-vectors':
            db=self.databases[request['dbId']]
            with_cursor=db.nearest_vectors(decode(request['vector']),request['limit'])
            try:return dict(rows=[encode(dict(row)) for row in with_cursor])
            finally:with_cursor.close()
        if operation=='logical-manifest':return dict(manifest=self.databases[request['dbId']].logical_manifest())
        if operation=='table-columns':return dict(columns=self.databases[request['dbId']].table_columns(request['table']))
        if operation in ('run','get','all'):
            db=self.databases[request['dbId']];cur=db.execute(request['sql'],decode(request.get('params',[])))
            try:
                if operation=='run':
                    if cur.description is not None:
                        for _ in cur:pass
                    return dict(changes=max(cur.rowcount,0),lastInsertRowid=cur.lastrowid if cur.lastrowid is not None else db.lastrowid or 0)
                if operation=='get':
                    row=cur.fetchone();return dict(row=encode(dict(row),bigints=request.get('readBigInts',False)) if row is not None else None)
                rows=[];size=0
                for row in cur:
                    value=encode(dict(row),bigints=request.get('readBigInts',False))
                    size+=len(json.dumps(value,ensure_ascii=False,allow_nan=False).encode('utf8'))
                    require(size<MAX_RESPONSE-1024,'RESULT_STREAM_REQUIRED')
                    rows.append(value)
                return dict(rows=rows)
            finally:cur.close()
        if operation=='object.open':
            store,key=self.object_store(request['path'],read_only=bool(request.get('readOnly')))
            mode=request.get('mode','r')
            if mode=='r':handle=store.open_read(key)
            else:
                require(mode in ('w','x','a'),'FILE_MODE')
                handle=store.open_write(key,exclusive=mode=='x',append=mode=='a',expected_revision=request.get('expectedRevision'))
            return dict(fileId=self.allocate(self.files,handle))
        if operation.startswith('file.'):
            id=request['fileId'];handle=self.files[id];action=operation[5:]
            if action=='read':
                maximum=request['length'];require(type(maximum) is int and 0<=maximum<=BLOCK,'READ_CHUNK_LIMIT')
                return dict(bytes=handle.read(maximum) if request.get('position') is None else handle.read_at(maximum,request['position']))
            if action=='write':
                value=decode(request['bytes']);require(isinstance(value,bytes) and len(value)<=BLOCK,'WRITE_CHUNK_LIMIT')
                return dict(written=handle.write(value))
            if action=='flush':handle.flush();return dict()
            if action=='checkpoint':return dict(result=handle.checkpoint())
            if action=='stat':
                if hasattr(handle,'item'):
                    item=handle.item
                    return dict(stat=dict(kind='file',size=item['size'],position=handle.tell(),objectId=item['objectId'],revision=item['revision'],sha256=item['sha256']))
                return dict(stat=dict(kind='file',size=handle.size,position=handle.tell(),objectId=handle.object_id,revision=(handle.result or {}).get('revision'),sha256=handle.digest.hexdigest()))
            if action=='close':
                try:handle.close();return dict(result=getattr(handle,'result',None))
                finally:self.files.pop(id)
            if action=='abort':
                try:handle.abort();return dict()
                finally:self.files.pop(id)
            raise StoreError('ORBITA_PG_FILE_OPERATION_UNSUPPORTED')
        if operation.startswith('object.'):
            store,key=self.object_store(request['path'],read_only=bool(request.get('readOnly')))
            action=operation[7:]
            if action=='stat':return dict(stat=store.stat(key))
            if action=='describe-store':return dict(info=store.raw.execute('SELECT orbita_common.describe_store(%s)',(key,)).fetchone()[0])
            if action=='read-small':
                value=store.read_small(key)
                return dict(complete=value is not None,bytes=encode(value))
            if action=='write-small':
                value=decode(request['bytes']);require(isinstance(value,bytes) and len(value)<=BLOCK,'WRITE_CHUNK_LIMIT')
                return dict(written=store.write_small(key,value,exclusive=bool(request.get('exclusive'))))
            if action=='exists':return dict(exists=store.exists(key))
            if action=='contained-path':
                base_binding,base=binding_for(request['base'],self.config)
                require(base_binding.workspace_id==store.session.binding.workspace_id,'CROSS_WORKSPACE_PATH')
                return dict(key=store.contained_path(base,key))
            if action=='mkdir':store.mkdir(key,parents=bool(request.get('recursive')),exist_ok=bool(request.get('existOk')));return dict()
            if action=='list':return dict(entries=store.listdir(key))
            if action=='unlink':store.unlink(key,missing_ok=bool(request.get('missingOk')));return dict()
            if action=='rmdir':store.rmdir(key);return dict()
            if action=='purge':return dict(result=store.purge_tree(key,recursive=bool(request.get('recursive')),missing_ok=bool(request.get('missingOk'))))
            if action=='clone':
                target_binding,target=binding_for(request['target'],self.config)
                require(target_binding.workspace_id==store.session.binding.workspace_id,'CROSS_WORKSPACE_CLONE')
                return dict(result=store.clone_tree(key,target))
            if action=='rename':
                target_binding,target=binding_for(request['target'],self.config)
                require(target_binding.workspace_id==store.session.binding.workspace_id,'CROSS_WORKSPACE_RENAME')
                store.rename(key,target,replace=bool(request.get('replace',True)));return dict()
            if action=='copy':
                target_binding,target=binding_for(request['target'],self.config)
                require(target_binding.workspace_id==store.session.binding.workspace_id,'CROSS_WORKSPACE_COPY')
                store.copy_file(key,target,exclusive=bool(request.get('exclusive')));return dict()
            if action=='reclaim':return store.reclaim()
            raise StoreError('ORBITA_PG_OBJECT_OPERATION_UNSUPPORTED')
        if operation=='identity':return dict(instanceId=self.config.instance_id,database=self.config.dbname,pid=os.getpid())
        if operation=='shutdown':self.close();return dict(shutdown=True)
        raise StoreError('ORBITA_PG_BRIDGE_OPERATION_UNSUPPORTED')

    def close(self):
        from .pool import close_idle
        errors=[]
        # Stores own file handles and abort every unpublished writer.
        for collection in (self.transfers,self.databases,self.stores,self.leases):
            for value in list(collection.values()):
                try:value.close()
                except BaseException as error:errors.append(error)
            collection.clear()
        self.files.clear()
        close_idle()
        if errors:raise errors[0]


def main():
    sys.stdin.reconfigure(encoding='utf8',errors='strict')
    sys.stdout.reconfigure(encoding='utf8',errors='strict')
    bridge=None
    try:
        bridge=Bridge()
        while True:
            line=sys.stdin.readline(MAX_REQUEST+1)
            if not line:break
            if len(line.encode('utf8'))>MAX_REQUEST or not line.endswith('\n'):
                raise StoreError('ORBITA_PG_REQUEST_LIMIT')
            request=json.loads(line);id=request.get('id')
            try:
                result=bridge.call(request);response=dict(ok=True,id=id,**encode(result))
                text=json.dumps(response,ensure_ascii=False,allow_nan=False,separators=(',',':'))
                require(len(text.encode('utf8'))<=MAX_RESPONSE,'RESPONSE_LIMIT')
            except BaseException as error:
                # Response encoding/size validation can fail after a write.
                bridge.fail_request(request)
                # SQL diagnostics can contain source text, payloads or tokens.
                # Return stable types/codes, never a credential-bearing detail.
                code=getattr(error,'code',None) or getattr(error,'sqlstate',None) or (errno.errorcode.get(error.errno,'ERRNO_'+str(error.errno)) if isinstance(error,OSError) else 'ORBITA_PG_OPERATION_FAILED')
                response=dict(ok=False,id=id,code=code,error=code,errorType=type(error).__name__)
                text=json.dumps(response,ensure_ascii=False,allow_nan=False,separators=(',',':'))
            print(text,flush=True)
            if request.get('op')=='shutdown':break
    finally:
        if bridge is not None:bridge.close()


if __name__=='__main__':main()
