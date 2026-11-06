"""Prepare hash-checked bytecode for the exact pinned, private Python runtime.

This compiles installed dependency code only. It neither connects to a store
nor writes application data, and -B consumers still validate source hashes.
"""
import argparse
import base64
import datetime
import hashlib
import importlib.metadata
import importlib.util
import json
import py_compile
import stat
import sys
from pathlib import Path

PACKAGES={'psycopg':'3.2.9','psycopg-binary':'3.2.9','sqlglot':'30.27.0',
          'typing_extensions':'4.16.0','tzdata':'2026.6'}


def plain(path,root):
    path=path.absolute()
    if '..' in path.parts or not path.is_relative_to(root):raise ValueError('RUNTIME_PATH_OUTSIDE_PRIVATE_ENVIRONMENT')
    for item in [path,*path.parents]:
        if not item.exists():continue
        info=item.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info,'st_file_attributes',0)&0x400:
            raise ValueError('RUNTIME_ALIAS_FORBIDDEN')
        if stat.S_ISREG(info.st_mode) and info.st_nlink!=1:raise ValueError('RUNTIME_HARDLINK_FORBIDDEN')
    return path


def prepare(receipt):
    root=Path(sys.prefix).absolute()
    if root==Path(sys.base_prefix).absolute() or not (root/'pyvenv.cfg').is_file():
        raise ValueError('PRIVATE_VIRTUAL_ENVIRONMENT_REQUIRED')
    plain(root,root)
    receipt=plain(Path(receipt),root)
    if receipt.exists() or receipt.suffix!='.json':raise ValueError('NEW_RUNTIME_RECEIPT_REQUIRED')
    # Validate every source against its wheel RECORD before producing bytecode.
    sources={}
    for name,version in PACKAGES.items():
        dist=importlib.metadata.distribution(name)
        if dist.version!=version:raise ValueError('PINNED_RUNTIME_VERSION_MISMATCH:'+name)
        for entry in dist.files or []:
            if entry.suffix!='.py':continue
            file=plain(Path(dist.locate_file(entry)),root)
            raw=file.read_bytes();digest=hashlib.sha256(raw).digest()
            encoded=base64.urlsafe_b64encode(digest).rstrip(b'=').decode('ascii')
            if entry.hash is None or entry.hash.mode!='sha256' or entry.hash.value!=encoded or entry.size!=len(raw):
                raise ValueError('PINNED_RUNTIME_SOURCE_MISMATCH:'+str(entry))
            cache=plain(Path(importlib.util.cache_from_source(str(file),optimization='')),root)
            sources[str(file)]=dict(source=str(file.relative_to(root)),sourceSha256=digest.hex(),
                bytes=len(raw),cache=str(cache.relative_to(root)),
                priorCacheSha256=hashlib.sha256(cache.read_bytes()).hexdigest() if cache.exists() else None,
                priorCacheBytes=cache.stat().st_size if cache.exists() else 0)
    if not sources:raise ValueError('PINNED_RUNTIME_SOURCE_MISSING')
    rows=[]
    for filename,row in sorted(sources.items()):
        file=Path(filename);cache=root/row['cache']
        py_compile.compile(str(file),cfile=str(cache),doraise=True,optimize=0,
                           invalidation_mode=py_compile.PycInvalidationMode.CHECKED_HASH)
        data=cache.read_bytes()
        if data[:4]!=importlib.util.MAGIC_NUMBER or int.from_bytes(data[4:8],'little')!=3 or data[8:16]!=importlib.util.source_hash(file.read_bytes()):
            raise ValueError('RUNTIME_CHECKED_HASH_CACHE_MISMATCH')
        if hashlib.sha256(file.read_bytes()).hexdigest()!=row['sourceSha256']:
            raise ValueError('RUNTIME_SOURCE_CHANGED_DURING_PREPARATION')
        rows.append(dict(**row,cacheBytes=len(data),cacheSha256=hashlib.sha256(data).hexdigest()))
    result=dict(at=datetime.datetime.now(datetime.timezone.utc).isoformat(),status='PASS_PINNED_RUNTIME_PREPARATION_ONLY',
                executable=sys.executable,python=sys.version,root=str(root),packages=PACKAGES,
                invalidation='CHECKED_HASH',files=rows,cacheBytes=sum(row['cacheBytes'] for row in rows),
                netBytes=sum(row['cacheBytes']-row['priorCacheBytes'] for row in rows),
                applicationSourcesModified=False,applicationDataCreated=False)
    with receipt.open('x',encoding='utf8') as stream:json.dump(result,stream,indent=2)
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--receipt',required=True)
    result=prepare(parser.parse_args().receipt)
    print(json.dumps({key:result[key] for key in ('status','cacheBytes','netBytes','invalidation')}))
