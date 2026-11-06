"""Explicit PostgreSQL paths. Native inputs and exports keep pathlib.Path.

A path is only a locator under a configured workspace. There is no filesystem
fallback and resolving it never creates a local directory or a database file.
"""
from contextlib import contextmanager
import io
import os
from pathlib import Path as NativePath
from types import SimpleNamespace

from .config import binding_for, read_config, require
from .objects import ObjectStore


class Path(os.PathLike):
    def __init__(self, *parts, config=None):
        inherited=parts[0].config if parts and isinstance(parts[0],Path) else None
        self.config=config or inherited or read_config()
        raw=NativePath(*(os.fspath(p) for p in parts))
        self.binding,self.key=binding_for(raw,self.config)
        self.native=NativePath(self.binding.root)/self.key

    def __fspath__(self):return str(self.native)
    def __str__(self):return str(self.native)
    def __repr__(self):return 'CommonPath('+repr(str(self))+')'
    def __truediv__(self,other):return type(self)(self,other,config=self.config)
    def __eq__(self,other):return isinstance(other,Path) and self.native==other.native and self.binding.workspace_id==other.binding.workspace_id
    def __hash__(self):return hash((self.native,self.binding.workspace_id))
    @property
    def name(self):return self.native.name
    @property
    def parent(self):return type(self)(self.native.parent,config=self.config)
    @property
    def suffix(self):return self.native.suffix
    @property
    def parts(self):return self.native.parts
    def joinpath(self,*parts):return type(self)(self,*parts,config=self.config)
    def with_name(self,name):return type(self)(self.native.with_name(name),config=self.config)
    def resolve(self,strict=False):
        if strict:self.stat()
        return self
    def as_posix(self):return self.native.as_posix()
    def relative_to(self,other):return self.native.relative_to(os.fspath(other))

    @contextmanager
    def store(self,*,read_only=False):
        with ObjectStore(self.config,self.binding,read_only=read_only) as value:yield value

    def exists(self):
        with self.store(read_only=True) as store:return store.exists(self.key)
    def stat(self):
        with self.store(read_only=True) as store:return SimpleNamespace(**store.stat(self.key))
    def is_dir(self):
        try:return self.stat().kind=='directory'
        except FileNotFoundError:return False
    def is_file(self):
        try:return self.stat().kind!='directory'
        except FileNotFoundError:return False
    def mkdir(self,mode=0o777,parents=False,exist_ok=False):
        with self.store() as store:store.mkdir(self.key,parents=parents,exist_ok=exist_ok)
    def iterdir(self):
        with self.store(read_only=True) as store:items=store.listdir(self.key)
        return (self/item['name'] for item in items)
    def read_bytes(self):
        with self.store(read_only=True) as store:return store.read_bytes(self.key)
    def read_text(self,encoding='utf8',errors='strict'):
        return self.read_bytes().decode(encoding,errors)
    def write_bytes(self,value):
        with self.store() as store:return store.write_bytes(self.key,value)
    def write_text(self,value,encoding='utf8',errors='strict',newline=None):
        with self.open('w',encoding=encoding,errors=errors,newline=newline) as stream:return stream.write(value)
    def unlink(self,missing_ok=False):
        with self.store() as store:store.unlink(self.key,missing_ok=missing_ok)
    def rmdir(self):
        with self.store() as store:store.rmdir(self.key)
    def rename(self,target):
        target=type(self)(target,config=self.config)
        require(target.binding.workspace_id==self.binding.workspace_id,'CROSS_WORKSPACE_RENAME')
        with self.store() as store:store.rename(self.key,target.key)
        return target
    replace=rename

    @contextmanager
    def open(self,mode='r',encoding=None,errors=None,newline=None):
        require(mode in ('r','rb','rt','w','wb','wt','x','xb','xt','a','ab','at'),'FILE_MODE')
        reading=mode[0]=='r'
        with self.store(read_only=reading) as store:
            raw=store.open_read(self.key) if reading else store.open_write(self.key,exclusive=mode[0]=='x',append=mode[0]=='a')
            stream=raw if 'b' in mode else io.TextIOWrapper(raw,encoding=encoding or 'utf8',errors=errors or 'strict',newline=newline)
            try:
                yield stream
                stream.close()
            except BaseException:
                if not reading:raw.abort()
                stream.close()
                raise
