"""Versioned byte objects in the same PostgreSQL database as relational rows.

Reads pin immutable versions. Writes buffer at most one MiB and publish a name
atomically. Renames never copy bytes. The native filesystem is not a fallback.
"""
import errno
from contextlib import nullcontext
import hashlib
import io
import os
from pathlib import PurePosixPath
import re
import stat
import psycopg

from . import StoreError
from .config import require
from .session import Session

BLOCK=1024*1024


def logical_key(value):
    require(isinstance(value,str) and len(value)<=4096,'OBJECT_PATH')
    require(not re.search(r'(^/|(^|/)\.\.(/|$)|\\|:|[\x00-\x1f])',value),'OBJECT_PATH_ESCAPE')
    return str(PurePosixPath(value)) if value else ''


def file_error(code,key):
    return OSError(code,os.strerror(code),key)


class ObjectStore:
    def __init__(self,config,binding,*,read_only=False):
        self.session=Session(config,binding,read_only=read_only)
        self.raw=self.session.raw
        self.handles=set()
        self.owner=None;self.closed=False;self.scope=None

    @classmethod
    def borrow(cls,connection):
        require(connection.in_transaction and not connection.session.read_only,'OBJECT_TRANSACTION_REQUIRED')
        require(connection.raw.execute('SHOW transaction_isolation').fetchone()[0]=='repeatable read','OBJECT_REPEATABLE_TRANSACTION_REQUIRED')
        value=object.__new__(cls)
        value.session=connection.session;value.raw=connection.raw
        value.handles=set();value.owner=connection;value.closed=False
        value.scope=connection.store_key.rpartition('/')[0]
        require(bool(value.scope),'OBJECT_TRANSACTION_PATH_ESCAPE')
        return value

    def _key(self,key):
        self._usable();key=logical_key(key)
        require(self.scope is None or key==self.scope or key.startswith(self.scope+'/'),'OBJECT_TRANSACTION_PATH_ESCAPE')
        return key

    def _usable(self):
        require(not self.closed and not self.session.closed,'OBJECT_STORE_CLOSED')
        require(self.owner is None or self.owner.in_transaction,'OBJECT_TRANSACTION_REQUIRED')

    def _writable(self):
        self._usable();require(not self.session.read_only,'READ_ONLY')

    def _lock(self,*,shared=False):
        self._usable()
        function='pg_advisory_xact_lock_shared' if shared else 'pg_advisory_xact_lock'
        self.raw.execute("SELECT "+function+"(hashtextextended('names:' || orbita_common.workspace_id()::text,0))")

    def _entry(self,key,*,locked=False,pin=False):
        self._usable()
        # The immutable-version pin and its metadata come from one statement.
        # Callers requesting a pin hold the shared namespace lock until commit.
        extra=",CASE WHEN e.kind='file' THEN orbita_common.pin_object(e.object_id) END" if pin else ''
        row=self.raw.execute('SELECT e.kind,e.object_id::text,e.store_id::text,e.revision,e.created_at,e.modified_at,o.size,o.sha256'+extra+' '
            'FROM orbita_common.entries e LEFT JOIN orbita_common.objects o ON o.workspace_id=e.workspace_id AND o.id=e.object_id '
            'WHERE e.path=%s'+(' FOR UPDATE OF e' if locked else ''),(key,)).fetchone()
        fields=('kind','objectId','storeId','revision','createdAt','modifiedAt','size','sha256')+(('pin',) if pin else ())
        return dict(zip(fields,row)) if row else None

    def _parent(self,key):
        parent=str(PurePosixPath(key).parent)
        parent='' if parent=='.' else parent
        found=self._entry(parent)
        if found is None:raise file_error(errno.ENOENT,parent)
        if found['kind']!='directory':raise file_error(errno.ENOTDIR,parent)

    def stat(self,key):
        key=self._key(key);item=self._entry(key)
        if item is None:raise file_error(errno.ENOENT,key)
        return dict(**item,st_size=item['size'] or 0,st_mode=(stat.S_IFDIR if item['kind']=='directory' else stat.S_IFREG)|0o600,
                    st_nlink=1,st_mtime=item['modifiedAt'].timestamp(),st_ctime=item['createdAt'].timestamp())

    def exists(self,key):return self._entry(self._key(key)) is not None

    def contained_path(self,base,key):
        """Check the entire logical path in one fresh PostgreSQL snapshot."""
        base=self._key(base);key=self._key(key);prefix=base+'/' if base else ''
        require(key!=base and key.startswith(prefix),'OBJECT_PATH_ESCAPE')
        parts=key[len(prefix):].split('/');names=[base]
        for count in range(1,len(parts)+1):names.append(prefix+'/'.join(parts[:count]))
        rows=dict(self.raw.execute('SELECT path,kind FROM orbita_common.entries WHERE path=ANY(%s::text[])',(names,)).fetchall())
        for name in names:
            if name not in rows:raise file_error(errno.ENOENT,name)
            if name!=key and rows[name]!='directory':raise file_error(errno.ENOTDIR,name)
        return key

    def mkdir(self,key,*,parents=False,exist_ok=False):
        self._writable();key=self._key(key)
        try:
            # The server owns the same namespace transaction. A caller's outer
            # transaction still gets a savepoint, including filesystem errors.
            nested=self.raw.info.transaction_status!=psycopg.pq.TransactionStatus.IDLE
            with self.raw.transaction() if nested else nullcontext():
                self.raw.execute('SELECT orbita_common.make_directory(%s,%s,%s)',(key,bool(parents),bool(exist_ok))).fetchone()
        except psycopg.Error as error:
            code={'ORBITA_PG_MKDIR_EXISTS':errno.EEXIST,
                  'ORBITA_PG_MKDIR_PARENT_MISSING':errno.ENOENT,
                  'ORBITA_PG_MKDIR_PARENT_NOT_DIRECTORY':errno.ENOTDIR}.get(error.diag.message_primary)
            if code is not None:raise file_error(code,error.diag.message_detail) from None
            raise

    def listdir(self,key):
        key=self._key(key);item=self.stat(key)
        if item['kind']!='directory':raise file_error(errno.ENOTDIR,key)
        prefix=key+'/' if key else ''
        rows=self.raw.execute("SELECT path,kind FROM orbita_common.entries WHERE starts_with(path,%s) AND path<>%s AND strpos(substring(path from %s),'/')=0 ORDER BY path COLLATE \"C\"",(prefix,key,len(prefix)+1)).fetchall()
        return [dict(name=name[len(prefix):],kind=kind) for name,kind in rows]

    def open_read(self,key):return ObjectReader(self,self._key(key))

    def open_write(self,key,*,exclusive=False,append=False,expected_revision=None):
        self._writable()
        return ObjectWriter(self,self._key(key),exclusive=exclusive,append=append,expected_revision=expected_revision)

    def read_small(self,key):
        """One fresh statement owns all metadata and bytes up to one block.

        MVCC retains every joined row through this statement, even if another
        writer replaces the name and reclaims its old object concurrently.
        Larger files return no bytes and use the pinned streaming reader.
        """
        key=self._key(key)
        row=self.raw.execute('''SELECT e.kind,o.complete,o.size,o.sha256,
            CASE WHEN o.size<=%s THEN b.bytes END,c.chunk_hash
            FROM orbita_common.entries e
            LEFT JOIN orbita_common.objects o ON o.workspace_id=e.workspace_id AND o.id=e.object_id
            LEFT JOIN orbita_common.object_chunks c ON c.workspace_id=o.workspace_id AND c.object_id=o.id AND c.ordinal=0
            LEFT JOIN orbita_common.chunk_blobs b ON b.workspace_id=c.workspace_id AND b.sha256=c.chunk_hash
            WHERE e.path=%s''',(BLOCK,key)).fetchone()
        if row is None:raise file_error(errno.ENOENT,key)
        kind,complete,size,digest,payload,chunk_hash=row
        if kind=='directory':raise file_error(errno.EISDIR,key)
        require(kind=='file','LOGICAL_STORE_BYTES_NOT_AVAILABLE')
        require(complete is True and type(size) is int and size>=0,'OBJECT_INCOMPLETE')
        if size>BLOCK:return None
        if size==0:
            require(payload is None and chunk_hash is None,'OBJECT_CHUNK_LENGTH')
            value=b''
        else:
            require(payload is not None,'OBJECT_CHUNK_MISSING');value=bytes(payload)
            require(len(value)==size,'OBJECT_CHUNK_LENGTH')
            require(hashlib.sha256(value).hexdigest()==chunk_hash,'OBJECT_CHUNK_HASH')
        require(hashlib.sha256(value).hexdigest()==digest,'OBJECT_HASH')
        return value

    def read_bytes(self,key):
        small=self.read_small(key)
        if small is not None:return small
        with self.open_read(key) as stream:return stream.read()

    def write_bytes(self,key,value,**options):
        if not options and len(memoryview(value).cast('B'))<=BLOCK:
            return self.write_small(key,value)
        with self.open_write(key,**options) as stream:return stream.write(value)

    def write_small(self,key,value,*,exclusive=False):
        self._writable();key=self._key(key);view=memoryview(value).cast('B')
        require(len(view)<=BLOCK and type(exclusive) is bool,'SMALL_WRITE_ARGUMENT')
        value=bytes(view)
        try:
            # Preserve the existing savepoint behavior inside a caller transaction.
            # An autocommit statement already owns its complete atomic transaction.
            nested=self.raw.info.transaction_status!=psycopg.pq.TransactionStatus.IDLE
            with self.raw.transaction() if nested else nullcontext():
                result=self.raw.execute('SELECT orbita_common.write_small_object(%s,%s,%s)',(key,value,exclusive)).fetchone()[0]
        except psycopg.Error as error:
            code={'ORBITA_PG_SMALL_WRITE_PARENT_MISSING':errno.ENOENT,
                  'ORBITA_PG_SMALL_WRITE_PARENT_NOT_DIRECTORY':errno.ENOTDIR,
                  'ORBITA_PG_SMALL_WRITE_IS_DIRECTORY':errno.EISDIR,
                  'ORBITA_PG_SMALL_WRITE_EXISTS':errno.EEXIST}.get(error.diag.message_primary)
            if code is not None:
                failed=str(PurePosixPath(key).parent) if code in (errno.ENOENT,errno.ENOTDIR) else key
                raise file_error(code,'' if failed=='.' and code in (errno.ENOENT,errno.ENOTDIR) else failed) from None
            raise
        if result['retiredObjectId']:self.collect([result['retiredObjectId']])
        return result['size']

    def collect(self,object_ids):
        self._writable()
        return self.raw.execute('SELECT orbita_common.collect_objects(%s::uuid[])',(list(object_ids),)).fetchone()[0]

    def reclaim(self):
        """One bounded pass over exact, unreferenced IDs with no live pins."""
        self._writable()
        ids=[row[0] for row in self.raw.execute('SELECT * FROM orbita_common.reclaim_candidates()')]
        return dict(candidates=[str(i) for i in ids],removed=self.collect(ids) if ids else 0)

    def unlink(self,key,*,missing_ok=False):
        self._writable();key=self._key(key);old=None
        with self.raw.transaction():
            self._lock();old=self._entry(key,locked=True)
            if old is None:
                if missing_ok:return
                raise file_error(errno.ENOENT,key)
            if old['kind']=='directory':raise file_error(errno.EISDIR,key)
            require(old['kind']=='file','LOGICAL_STORE_PURGE_REQUIRED')
            self.raw.execute('DELETE FROM orbita_common.entries WHERE path=%s',(key,))
        self.collect([old['objectId']])

    def rmdir(self,key):
        self._writable();key=self._key(key)
        require(bool(key),'ROOT_DELETE_FORBIDDEN')
        with self.raw.transaction():
            self._lock();item=self.stat(key)
            if item['kind']!='directory':raise file_error(errno.ENOTDIR,key)
            if self.listdir(key):raise file_error(errno.ENOTEMPTY,key)
            self.raw.execute('DELETE FROM orbita_common.entries WHERE path=%s',(key,))

    def rename(self,source,target,*,replace=True):
        self._writable();source=self._key(source);target=self._key(target)
        require(bool(source) and bool(target),'ROOT_RENAME_FORBIDDEN')
        if source==target:
            self.stat(source);return
        require(not target.startswith(source+'/'),'RENAME_INTO_SELF')
        # Preflight provides filesystem-shaped errors; the server repeats all
        # checks under the same workspace lock and moves table locators too.
        with self.raw.transaction():
            self._lock();old=self._entry(source,locked=True)
            if old is None:raise file_error(errno.ENOENT,source)
            self._parent(target);other=self._entry(target,locked=True)
            if other:
                if not replace:raise file_error(errno.EEXIST,target)
                if old['kind']!=other['kind']:raise file_error(errno.ENOTDIR,target)
                if other['kind']=='directory' and self.listdir(target):raise file_error(errno.ENOTEMPTY,target)
            self.raw.execute('SELECT orbita_common.rename_tree(%s,%s,%s)',(source,target,replace))

    def copy_file(self,source,target,*,exclusive=False):
        self._writable();source=self._key(source);target=self._key(target);old=None
        require(source!=target,'COPY_SAME_PATH')
        with self.raw.transaction():
            self._lock();item=self._entry(source)
            if item is None:raise file_error(errno.ENOENT,source)
            require(item['kind']=='file','COPY_FILE_REQUIRED')
            self._parent(target);old=self._entry(target,locked=True)
            if old and exclusive:raise file_error(errno.EEXIST,target)
            if old and old['kind']!='file':raise file_error(errno.EISDIR,target)
            self.raw.execute("INSERT INTO orbita_common.entries(path,kind,object_id) VALUES(%s,'file',%s::uuid) ON CONFLICT(workspace_id,path) DO UPDATE SET object_id=excluded.object_id,revision=orbita_common.entries.revision+1,modified_at=clock_timestamp()",(target,item['objectId']))
        if old:self.collect([old['objectId']])

    def purge_tree(self,key,*,recursive=False,missing_ok=False):
        self._writable();key=self._key(key)
        require(bool(key),'ROOT_DELETE_FORBIDDEN')
        with self.raw.transaction():
            return self.raw.execute('SELECT orbita_common.purge_tree(%s,%s,%s)',(key,recursive,missing_ok)).fetchone()[0]

    def clone_tree(self,source,target):
        self._writable();source=self._key(source);target=self._key(target)
        require(bool(source) and bool(target),'ROOT_CLONE_FORBIDDEN')
        require(self.raw.info.transaction_status.value==0,'CLONE_INDEPENDENT_SNAPSHOT_REQUIRED')
        self.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ')
        try:
            result=self.raw.execute('SELECT orbita_common.clone_tree(%s,%s)',(source,target)).fetchone()[0]
            self.raw.commit();return result
        except BaseException:
            self.raw.rollback();raise

    def close(self):
        if self.closed:return
        # An unclosed writer has not published its name. Discard that exact
        # staging object; closing a store must never commit an abandoned write.
        error=None
        try:
            for handle in list(self.handles):
                try:
                    if isinstance(handle,ObjectWriter):handle.abort()
                    else:handle.close()
                except BaseException as e:
                    if error is None:error=e
            if self.owner is None and not self.session.read_only and not self.raw.closed:
                try:self.reclaim()
                except BaseException as e:
                    if error is None:error=e
        finally:
            self.closed=True
            if self.owner is None:self.session.close(reusable=error is None)
        if error is not None:raise error

    def __enter__(self):return self
    def __exit__(self,*unused):self.close()


class ObjectReader(io.RawIOBase):
    def __init__(self,store,key):
        super().__init__();self.store=store;self.key=key;self.pin=None
        self.position=0;self.cached_index=None;self.cached=b'';self.digest=hashlib.sha256();self.hash_position=0
        with store.raw.pipeline(),store.raw.transaction():
            store._lock(shared=True)
            item=store._entry(key,pin=True)
            if item is None:raise file_error(errno.ENOENT,key)
            if item['kind']=='directory':raise file_error(errno.EISDIR,key)
            require(item['kind']=='file','LOGICAL_STORE_BYTES_NOT_AVAILABLE')
            self.pin=item.pop('pin')
            self.item=item
        store.handles.add(self)

    def readable(self):return True
    def seekable(self):return True
    def tell(self):return self.position
    def seek(self,offset,whence=io.SEEK_SET):
        self._checkClosed()
        start={io.SEEK_SET:0,io.SEEK_CUR:self.position,io.SEEK_END:self.item['size']}.get(whence)
        if start is None or start+offset<0:raise ValueError('invalid seek')
        self.position=start+offset
        if self.position==0:self.digest=hashlib.sha256();self.hash_position=0
        elif self.position!=self.hash_position:self.hash_position=None
        return self.position

    def _chunk(self,index):
        if index!=self.cached_index:
            row=self.store.raw.execute('SELECT b.bytes,c.chunk_hash FROM orbita_common.object_chunks c JOIN orbita_common.chunk_blobs b ON b.workspace_id=c.workspace_id AND b.sha256=c.chunk_hash WHERE c.object_id=%s::uuid AND c.ordinal=%s',(self.item['objectId'],index),binary=True).fetchone()
            require(row is not None,'OBJECT_CHUNK_MISSING')
            value=bytes(row[0]);require(hashlib.sha256(value).hexdigest()==row[1],'OBJECT_CHUNK_HASH')
            self.cached_index=index;self.cached=value
        return self.cached

    def readinto(self,buffer):
        self._checkClosed();view=memoryview(buffer).cast('B');count=0
        while count<len(view) and self.position<self.item['size']:
            index,offset=divmod(self.position,BLOCK);chunk=self._chunk(index)
            take=min(len(chunk)-offset,len(view)-count,self.item['size']-self.position)
            require(take>0,'OBJECT_CHUNK_LENGTH')
            value=chunk[offset:offset+take];view[count:count+take]=value
            if self.hash_position==self.position:self.digest.update(value);self.hash_position+=take
            self.position+=take;count+=take
        if self.position==self.item['size'] and self.hash_position==self.position:
            require(self.digest.hexdigest()==self.item['sha256'],'OBJECT_HASH')
        return count

    def read_at(self,length,position):
        require(type(position) is int and position>=0,'READ_POSITION')
        saved=(self.position,self.digest.copy(),self.hash_position)
        try:
            self.seek(position)
            return self.read(length)
        finally:self.position,self.digest,self.hash_position=saved

    def close(self):
        if not self.closed:
            try:
                if self.pin is not None and not self.store.raw.closed:
                    self.store.raw.execute('SELECT orbita_common.unpin_object(%s::uuid)',(self.pin,))
            finally:
                self.store.handles.discard(self);super().close()


class ObjectWriter(io.RawIOBase):
    def __init__(self,store,key,*,exclusive=False,append=False,expected_revision=None):
        super().__init__();self.store=store;self.key=key;self.object_id=None;self.pin=None
        self.buffer=bytearray();self.ordinal=0;self.size=0;self.digest=hashlib.sha256();self.aborted=False
        self.exclusive=exclusive;self.expected_revision=expected_revision;self.result=None
        self.dirty=True
        self.aborted=True  # A failed constructor must never publish in __del__.
        with store.raw.transaction():
            store._lock();store._parent(key);prior=store._entry(key,locked=True)
            if prior and prior['kind']!='file':raise file_error(errno.EISDIR,key)
            if prior and exclusive:raise file_error(errno.EEXIST,key)
            if append:self.expected_revision=prior['revision'] if prior else 0
            self.object_id=store.raw.execute('INSERT INTO orbita_common.objects DEFAULT VALUES RETURNING id::text').fetchone()[0]
            self.pin=store.raw.execute('SELECT orbita_common.pin_object(%s::uuid,true)',(self.object_id,)).fetchone()[0]
            store.raw.execute('SELECT orbita_common.register_writer(%s::uuid,%s)',(self.pin,key))
            if append and prior:
                # Chunk bytes are shared, not duplicated for each version.
                # Recompute the full byte digest while retaining bounded RAM.
                with store.open_read(key) as reader:
                    while True:
                        block=reader.read(BLOCK)
                        if not block:break
                        self.digest.update(block);self.size+=len(block)
                        if len(block)==BLOCK:
                            store.raw.execute('INSERT INTO orbita_common.object_chunks(object_id,ordinal,chunk_hash) SELECT %s::uuid,ordinal,chunk_hash FROM orbita_common.object_chunks WHERE object_id=%s::uuid AND ordinal=%s',(self.object_id,prior['objectId'],self.ordinal))
                            self.ordinal+=1
                        else:self.buffer.extend(block)
        store.handles.add(self);self.aborted=False

    def writable(self):return True
    def tell(self):return self.size

    def _flush_block(self):
        if not self.buffer:return
        value=bytes(self.buffer);digest=hashlib.sha256(value).hexdigest()
        with self.store.raw.transaction():
            self.store.raw.execute('INSERT INTO orbita_common.chunk_blobs(bytes) VALUES(%s) ON CONFLICT DO NOTHING',(value,))
            self.store.raw.execute('INSERT INTO orbita_common.object_chunks(object_id,ordinal,chunk_hash) VALUES(%s::uuid,%s,%s)',(self.object_id,self.ordinal,digest))
        self.ordinal+=1;self.buffer.clear()

    def write(self,value):
        self._checkClosed();require(not self.aborted,'WRITER_ABORTED')
        data=memoryview(value).cast('B');offset=0
        if len(data):self.dirty=True
        while offset<len(data):
            take=min(BLOCK-len(self.buffer),len(data)-offset);part=data[offset:offset+take]
            self.buffer.extend(part);self.digest.update(part);self.size+=take;offset+=take
            if len(self.buffer)==BLOCK:self._flush_block()
        return len(data)

    def flush(self):
        self._checkClosed()
        # Complete blocks are already synchronously committed. A partial block
        # remains buffered until publication, never exposed as a partial file.

    def abort(self):
        if self.closed:return
        self.aborted=True
        try:
            if self.object_id is not None and not self.store.raw.closed:
                self.store.raw.execute('SELECT orbita_common.unpin_object(%s::uuid)',(self.pin,))
                self.store.collect([self.object_id])
        finally:
            self.store.handles.discard(self);super().close()

    def _publish(self,continue_writing=False):
        self._checkClosed();require(not self.aborted,'WRITER_ABORTED')
        if not self.dirty:return self.result
        old=None
        tail=bytes(self.buffer);full_chunks=self.ordinal
        try:
            with self.store.raw.transaction():
                self.store._lock();self.store._parent(self.key);old=self.store._entry(self.key,locked=True)
                if old and old['kind']!='file':raise file_error(errno.EISDIR,self.key)
                if self.exclusive and old:raise file_error(errno.EEXIST,self.key)
                actual=old['revision'] if old else 0
                require(self.expected_revision is None or actual==self.expected_revision,'OBJECT_REVISION_CONFLICT')
                self._flush_block()
                self.store.raw.execute('UPDATE orbita_common.objects SET size=%s,sha256=%s,complete=true WHERE id=%s::uuid',(self.size,self.digest.hexdigest(),self.object_id))
                revision=self.store.raw.execute("INSERT INTO orbita_common.entries(path,kind,object_id) VALUES(%s,'file',%s::uuid) ON CONFLICT(workspace_id,path) DO UPDATE SET object_id=excluded.object_id,revision=orbita_common.entries.revision+1,modified_at=clock_timestamp() RETURNING revision",(self.key,self.object_id)).fetchone()[0]
                self.store.raw.execute('SELECT orbita_common.unpin_object(%s::uuid)',(self.pin,))
                result=dict(objectId=self.object_id,size=self.size,sha256=self.digest.hexdigest(),revision=revision)
                if continue_writing:
                    next_id=self.store.raw.execute('INSERT INTO orbita_common.objects DEFAULT VALUES RETURNING id::text').fetchone()[0]
                    next_pin=self.store.raw.execute('SELECT orbita_common.pin_object(%s::uuid,true)',(next_id,)).fetchone()[0]
                    self.store.raw.execute('SELECT orbita_common.register_writer(%s::uuid,%s)',(next_pin,self.key))
                    self.store.raw.execute('INSERT INTO orbita_common.object_chunks(object_id,ordinal,chunk_hash) SELECT %s::uuid,ordinal,chunk_hash FROM orbita_common.object_chunks WHERE object_id=%s::uuid AND ordinal<%s',(next_id,self.object_id,full_chunks))
        except BaseException:
            try:self.abort()
            except BaseException:pass  # Preserve the original operation error.
            raise
        else:
            self.result=result;self.dirty=False
            if continue_writing:
                self.object_id=next_id;self.pin=next_pin;self.ordinal=full_chunks
                self.buffer=bytearray(tail);self.expected_revision=revision;self.exclusive=False
            else:
                self.store.handles.discard(self);super().close()
            if old:self.store.collect([old['objectId']])
            return result

    def checkpoint(self):
        """Durably publish this prefix, preserving the open append capability.

        Complete blocks are referenced by the next version without re-reading
        or duplicating bytes; only the pending partial block stays in RAM.
        """
        return self._publish(continue_writing=True)

    def close(self):
        if self.closed:return
        if self.aborted or not self.dirty:return self.abort()
        self._publish()

    def __exit__(self,kind,*unused):
        if kind is None:self.close()
        else:self.abort()
