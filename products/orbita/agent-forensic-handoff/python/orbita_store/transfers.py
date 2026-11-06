"""Bounded typed row streams and atomic imports into new logical stores.

The stream contains data and a hash-bound description, never executable SQL.
All identifiers and constraints used for insertion come from the installed
server catalogue. Workspace authority and private control state stay outside.
"""
from contextlib import closing
from dataclasses import replace
import hashlib
import json
import math
import struct
import threading
import time
from types import SimpleNamespace

import psycopg
from psycopg.types.json import Jsonb

from . import StoreError
from .config import binding_for,require
from .connection import Connection
from .session import Session
from .schema import ident
from .manifests import Limits,frame,stable,manifest
from .objects import ObjectStore,BLOCK

MAGIC=b'ORBITA-ROWS-01\0'
META_LIMIT=1024*1024

def metadata(value):
    raw=stable(value);require(len(raw)<=META_LIMIT,'TRANSFER_METADATA_BUDGET')
    return struct.pack('>I',len(raw))+raw

def result_manifest(family,tables,shape):
    result=dict(format='orbita-common-rows-1',family=family,tables=sorted(tables,key=lambda t:t['name']),
                rows=sum(t['rows'] for t in tables),typedBytes=sum(t['typedBytes'] for t in tables),
                catalogueSha256=hashlib.sha256(stable(shape['catalogue'])).hexdigest(),
                countersSha256=hashlib.sha256(stable(shape['counters'])).hexdigest())
    result['sha256']=hashlib.sha256(stable(result)).hexdigest()
    return result

class Budget:
    def __init__(self,raw,limits):
        require(type(limits.rows) is int and limits.rows>0 and type(limits.bytes) is int and limits.bytes>0
                and type(limits.field_bytes) is int and limits.field_bytes>0 and limits.seconds>0,'TRANSFER_LIMITS')
        self.raw=raw;self.limits=limits;self.deadline=time.perf_counter()+limits.seconds
        self.cancelled=threading.Event();self.rows=0;self.bytes=0
        self.timer=threading.Timer(limits.seconds,self.cancel);self.timer.daemon=True;self.timer.start()
    def cancel(self):
        self.cancelled.set()
        try:self.raw.cancel_safe(timeout=5)
        except psycopg.Error:pass
    def check(self):require(time.perf_counter()<self.deadline,'TRANSFER_DEADLINE')
    def row(self):
        self.check();self.rows+=1;require(self.rows<=self.limits.rows,'TRANSFER_ROW_BUDGET')
    def field(self,size):
        self.check();require(size<=self.limits.field_bytes+9,'TRANSFER_FIELD_BUDGET')
        self.bytes+=size;require(self.bytes<=self.limits.bytes,'TRANSFER_BYTE_BUDGET')
    def remaining(self):
        self.check();return replace(self.limits,seconds=self.deadline-time.perf_counter())
    def close(self):
        self.timer.cancel();self.timer.join()

class StoreExport:
    """A read-only repeatable snapshot, consumed in at most one-MiB chunks."""
    def __init__(self,path,*,config,family=None,limits=None):
        self.connection=None;self.budget=None;self.iterator=None;self.pending=memoryview(b'')
        self.closed=False;self.done=False;self.delivered=0
        limits=limits or Limits()
        try:
            if family is None:
                binding,key=binding_for(path,config)
                with Session(config,binding,read_only=True) as session:
                    family=session.raw.execute('SELECT orbita_common.describe_store(%s)',(key,)).fetchone()[0]['family']
            self.connection=Connection(path,family=family,config=config,read_only=True)
            self.connection.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
            self.budget=Budget(self.connection.raw,limits)
            structure=self.connection.raw.execute('SELECT orbita_common.transfer_structure()').fetchone()[0]
            self.header=dict(schema='orbita-row-transfer-1',**structure)
            self.manifest=manifest(self.connection,limits=self.budget.remaining())
            self.budget.check()
            counts={t['name']:t for t in self.manifest['tables']}
            self.size=len(MAGIC)+len(metadata(self.header))+1+len(metadata(self.manifest))
            for name in structure['order']:
                table=counts[name]
                self.size+=5+table['rows']*5+table['typedBytes']+1+len(metadata(table))
            self.info=dict(format='orbita-row-transfer-1',family=family,size=self.size,rowsSha256=self.manifest['sha256'],manifest=self.manifest)
            self.iterator=self._pieces()
        except BaseException as error:
            cancelled=self.budget is not None and self.budget.cancelled.is_set();self.close()
            if isinstance(error,psycopg.errors.QueryCanceled) and cancelled:raise StoreError('ORBITA_PG_TRANSFER_DEADLINE') from None
            raise

    def _pieces(self):
        yield MAGIC;yield metadata(self.header)
        shapes={t['name']:t for t in self.header['shape']['tables']}
        counts={t['name']:t for t in self.manifest['tables']}
        for index,name in enumerate(self.header['order']):
            self.budget.check();shape=shapes[name];columns=shape['columns']
            yield b'T'+struct.pack('>I',index)
            query='SELECT '+','.join(ident(c['name']) for c in columns)+' FROM '+ident('orbita_'+self.connection.family)+'.'+ident(name)+' ORDER BY rowid'
            rows=typed_bytes=0;digest=hashlib.sha256()
            with self.connection.raw.cursor() as cursor:
                with closing(cursor.stream(query)) as stream:
                    for row in stream:
                        self.budget.row();rows+=1
                        marker=b'R'+struct.pack('>I',len(row));digest.update(marker);yield marker
                        for value in row:
                            encoded=frame(value);self.budget.field(len(encoded));typed_bytes+=len(encoded);digest.update(encoded);yield encoded
            observed=dict(name=name,schemaSha256=hashlib.sha256(stable(shape)).hexdigest(),rows=rows,typedBytes=typed_bytes,sha256=digest.hexdigest())
            require(observed==counts[name],'TRANSFER_SNAPSHOT_CHANGED')
            yield b'E'+metadata(observed)
        self.budget.check();yield b'Z'+metadata(self.manifest)

    def read(self,length=BLOCK):
        require(type(length) is int and 0<=length<=BLOCK,'TRANSFER_READ_BUDGET')
        if self.done:return b''
        require(not self.closed,'TRANSFER_CLOSED')
        parts=[];size=0
        try:
            self.budget.check()
            while size<length:
                if not len(self.pending):
                    try:self.pending=memoryview(next(self.iterator))
                    except StopIteration:
                        require(self.delivered+size==self.size,'TRANSFER_SIZE_MISMATCH')
                        self.done=True;self.close();break
                n=min(length-size,len(self.pending));parts.append(bytes(self.pending[:n]));self.pending=self.pending[n:];size+=n
            self.delivered+=size
            return b''.join(parts)
        except BaseException as error:
            cancelled=self.budget is not None and self.budget.cancelled.is_set();self.close()
            if isinstance(error,psycopg.errors.QueryCanceled) and cancelled:raise StoreError('ORBITA_PG_TRANSFER_DEADLINE') from None
            raise

    def close(self):
        if self.closed:return
        self.closed=True
        try:
            if self.iterator is not None:self.iterator.close()
        finally:
            self.pending=memoryview(b'')
            try:
                if self.connection is not None:self.connection.close()
            finally:
                if self.budget is not None:self.budget.close()
    def __enter__(self):return self
    def __exit__(self,*unused):self.close()

class Input:
    def __init__(self,stream,length,limits):
        require(type(length) is int and len(MAGIC)<length<=limits.bytes+limits.rows*5+4*META_LIMIT,'TRANSFER_LENGTH_BUDGET')
        self.stream=stream;self.length=length;self.offset=0;self.budget=None
    def read(self,n):
        require(type(n) is int and n>=0 and self.offset+n<=self.length,'TRANSFER_TRUNCATED')
        if self.budget:self.budget.check()
        parts=[];total=0
        while total<n:
            value=self.stream.read(min(BLOCK,n-total));require(bool(value),'TRANSFER_TRUNCATED')
            require(len(value)<=n-total,'TRANSFER_INPUT_PROTOCOL');parts.append(value);total+=len(value)
        self.offset+=n;return b''.join(parts)
    def metadata(self):
        n=struct.unpack('>I',self.read(4))[0];require(0<n<=META_LIMIT,'TRANSFER_METADATA_BUDGET')
        raw=self.read(n);value=json.loads(raw.decode('utf8'));require(stable(value)==raw,'TRANSFER_NONCANONICAL_METADATA');return value
    def value(self,digest):
        tag=self.read(1)
        if tag==b'N':self.budget.field(1);digest.update(tag);return None
        require(tag in (b'B',b'I',b'F',b'T'),'TRANSFER_VALUE_TYPE')
        encoded_length=self.read(8);n=struct.unpack('>Q',encoded_length)[0]
        require(n<=self.budget.limits.field_bytes,'TRANSFER_FIELD_BUDGET');self.budget.field(n+9)
        raw=self.read(n);digest.update(tag+encoded_length);digest.update(raw)
        if tag==b'B':return raw
        if tag==b'T':return raw.decode('utf8')
        if tag==b'I':
            require(0<n<=20,'TRANSFER_INTEGER');value=int(raw)
            require(str(value).encode('ascii')==raw and -(2**63)<=value<2**63,'TRANSFER_INTEGER');return value
        require(n==8,'TRANSFER_FLOAT');value=struct.unpack('>d',raw)[0];require(math.isfinite(value),'TRANSFER_NONFINITE');return value

def import_stream(stream,length,path,*,config,limits=None):
    """All effects, including locator, rowids and catalogue, commit together."""
    limits=limits or Limits();reader=Input(stream,length,limits);session=None;budget=None
    require(reader.read(len(MAGIC))==MAGIC,'TRANSFER_FORMAT');header=reader.metadata()
    require(isinstance(header,dict) and set(header)=={'schema','shape','order'} and header['schema']=='orbita-row-transfer-1','TRANSFER_FORMAT')
    shape=header['shape'];require(isinstance(shape,dict) and set(shape)=={'family','tables','catalogue','counters'},'TRANSFER_SHAPE')
    family=shape['family'];binding,key=binding_for(path,config)
    try:
        session=Session(config,binding);session.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ')
        budget=Budget(session.raw,limits);reader.budget=budget
        session.raw.execute('SELECT orbita_common.begin_store_import(%s,%s)',(key,family))
        actual=session.raw.execute('SELECT orbita_common.transfer_structure()').fetchone()[0]
        require(actual['shape']['family']==family and actual['shape']['tables']==shape['tables'] and actual['order']==header['order'],'TRANSFER_INSTALLED_SCHEMA_MISMATCH')
        shapes={t['name']:t for t in actual['shape']['tables']};tables=[]
        for index,name in enumerate(actual['order']):
            require(reader.read(1)==b'T' and struct.unpack('>I',reader.read(4))[0]==index,'TRANSFER_TABLE_ORDER')
            table=shapes[name];columns=table['columns'];insert_positions=[i for i,c in enumerate(columns) if not c['generated']]
            query='INSERT INTO '+ident('orbita_'+family)+'.'+ident(name)+' ('+','.join(ident(columns[i]['name']) for i in insert_positions)+') VALUES ('+','.join('%s' for _ in insert_positions)+')'
            digest=hashlib.sha256();rows=typed_bytes=0;batch=[];batch_bytes=0
            with session.raw.cursor() as cursor:
                def flush():
                    nonlocal batch,batch_bytes
                    if batch:cursor.executemany(query,batch);batch=[];batch_bytes=0;budget.check()
                while True:
                    marker=reader.read(1)
                    if marker==b'E':flush();break
                    require(marker==b'R','TRANSFER_ROW_MARKER');arity=reader.read(4)
                    require(struct.unpack('>I',arity)[0]==len(columns),'TRANSFER_ROW_ARITY')
                    budget.row();digest.update(marker+arity);before=budget.bytes
                    values=[reader.value(digest) for _ in columns];rows+=1;used=budget.bytes-before;typed_bytes+=used
                    batch.append(tuple(values[i] for i in insert_positions));batch_bytes+=used
                    if len(batch)>=100 or batch_bytes>=BLOCK:flush()
            observed=dict(name=name,schemaSha256=hashlib.sha256(stable(table)).hexdigest(),rows=rows,typedBytes=typed_bytes,sha256=digest.hexdigest())
            require(reader.metadata()==observed,'TRANSFER_TABLE_MANIFEST');tables.append(observed)
        require(reader.read(1)==b'Z','TRANSFER_END_REQUIRED');expected=result_manifest(family,tables,shape)
        require(reader.metadata()==expected and reader.offset==reader.length,'TRANSFER_FINAL_MANIFEST')
        session.raw.execute('SELECT orbita_common.finish_store_import(%s,%s)',(Jsonb(shape['catalogue']),Jsonb(shape['counters'])))
        restored=manifest(SimpleNamespace(raw=session.raw,family=family,in_transaction=True),limits=budget.remaining())
        require(restored==expected,'TRANSFER_RESTORED_ROWS_MISMATCH');budget.check();session.raw.commit()
        return dict(format='orbita-row-transfer-1',family=family,size=reader.offset,rowsSha256=expected['sha256'],manifest=expected)
    except BaseException as error:
        if session is not None and not session.raw.closed:session.raw.rollback()
        if isinstance(error,psycopg.errors.QueryCanceled) and budget is not None and budget.cancelled.is_set():
            raise StoreError('ORBITA_PG_TRANSFER_DEADLINE') from None
        raise
    finally:
        try:
            if session is not None:session.close()
        finally:
            if budget is not None:budget.close()

def import_object(source,offset,length,destination,*,config,limits=None,expected_object_id=None,expected_revision=None):
    require(type(offset) is int and offset>=0,'TRANSFER_OFFSET')
    binding,key=binding_for(source,config)
    with ObjectStore(config,binding,read_only=True) as objects:
        with objects.open_read(key) as stream:
            require(expected_object_id is None or stream.item['objectId']==expected_object_id,'TRANSFER_SOURCE_REPLACED')
            require(expected_revision is None or stream.item['revision']==expected_revision,'TRANSFER_SOURCE_REPLACED')
            require(type(length) is int and offset+length<=stream.item['size'],'TRANSFER_TRUNCATED')
            stream.seek(offset)
            return import_stream(stream,length,destination,config=config,limits=limits)
