"""Explicit legacy bundles: verified common staging, one atomic publication.

An import plan enumerates every native source and its hash. Durable byte
prefixes and already converted stores are read back on every resume. Copies of
old authority files can only be custody entries. Publication exposes the whole
verified tree at a new destination; it never replaces an operational tree.
"""
from contextlib import ExitStack, closing
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import uuid
from psycopg.types.json import Jsonb

from .config import binding_for, require
from .connection import Connection
from .leases import StoreLease
from .legacy_sqlite import NativeReadHold, SqliteTransfer, installed_structure
from .manifests import Limits, stable
from .objects import ObjectStore, BLOCK, logical_key
from .transfers import import_object

MAX_PLAN_ENTRIES=50000
MAX_PLAN_BYTES=8*1024**2


def serialize_plan(plan):
    """The exact CLI bytes obey the same bound as direct import plans."""
    chunks=[];size=0
    for piece in json.JSONEncoder(ensure_ascii=False,separators=(',',':')).iterencode(plan):
        raw=piece.encode('utf8');size+=len(raw)
        require(size<=MAX_PLAN_BYTES,'LEGACY_PLAN_DOCUMENT_BUDGET');chunks.append(raw)
    return b''.join(chunks)


def _alive(pid):
    from ctypes import wintypes
    require(type(pid) is int and pid>0,'LEGACY_OWNER_ID')
    api=ctypes.WinDLL('kernel32',use_last_error=True)
    api.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];api.OpenProcess.restype=wintypes.HANDLE
    api.GetExitCodeProcess.argtypes=[wintypes.HANDLE,ctypes.POINTER(wintypes.DWORD)]
    api.CloseHandle.argtypes=[wintypes.HANDLE]
    handle=api.OpenProcess(0x1000,False,pid)
    if not handle:return ctypes.get_last_error()!=87
    try:
        code=wintypes.DWORD()
        return not api.GetExitCodeProcess(handle,ctypes.byref(code)) or code.value==259
    finally:api.CloseHandle(handle)


def _guard_root(root,stack):
    """Do not insert/delete historical owners. A live PID conservatively blocks."""
    import sqlite3
    from afh_semantic.path_safety import native_path
    guard=root.parent/('.'+root.name+'.orbita-access.sqlite')
    if not native_path(guard).exists():return None
    held=stack.enter_context(NativeReadHold(guard))
    for suffix in ('-wal','-journal'):
        side=Path(str(guard)+suffix)
        if native_path(side).exists():require(stack.enter_context(NativeReadHold(side)).identity.st_size==0,'LEGACY_COHERENT_SNAPSHOT_REQUIRED')
    db=sqlite3.connect(held.sqlite_uri,uri=True)
    try:
        db.execute('PRAGMA query_only=ON')
        require(db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owners'").fetchone() is not None,'LEGACY_OWNER_SCHEMA')
        owners=db.execute('SELECT pid FROM owners LIMIT 10001').fetchall();require(len(owners)<=10000,'LEGACY_OWNER_BUDGET')
        require(not any(_alive(p[0]) for p in owners),'LEGACY_STORE_BUSY')
    finally:db.close()
    return dict(sha256=held.sha256,owners=len(owners),liveOwners=0,authorityRestored=False)


def _path(value):
    original=value;value=logical_key(value)
    require(value==original,'LEGACY_NONCANONICAL_PATH')
    require(bool(value) and value!='.' and not value.startswith('.orbita-'),'LEGACY_TARGET_PATH')
    return value


def checked_plan(plan,destination,stage,config):
    require(isinstance(plan,dict),'LEGACY_PLAN')
    version=plan.get('schema')
    require(version in ('orbita-legacy-plan-1','orbita-legacy-plan-2') and set(plan)==({'schema','sourceRoot','entries','derivations'} if version=='orbita-legacy-plan-2' else {'schema','sourceRoot','entries'}),'LEGACY_PLAN')
    require(Path(plan['sourceRoot']).is_absolute(),'LEGACY_ABSOLUTE_SOURCE_REQUIRED')
    entries=plan['entries'];require(isinstance(entries,list) and 0<len(entries)<=MAX_PLAN_ENTRIES,'LEGACY_PLAN_BUDGET')
    targets=set();sources=set()
    for item in entries:
        require(isinstance(item,dict) and set(item)==({'source','sha256','target','family','kind'} if item.get('kind')=='store' else {'source','sha256','target','kind'}),'LEGACY_PLAN_ENTRY')
        require(item['kind'] in ('store','file','custody'),'LEGACY_PLAN_KIND')
        if item['kind']=='store':require(item['family'] not in ('access','lease'),'LEGACY_CONTROL_CUSTODY_ONLY')
        source=_path(item['source']);target=_path(item['target'])
        require(source.casefold() not in sources and target.casefold() not in targets,'LEGACY_PLAN_DUPLICATE');sources.add(source.casefold());targets.add(target.casefold())
        require(re.fullmatch('[0-9a-f]{64}',item['sha256']) is not None,'LEGACY_EXPECTED_HASH_REQUIRED')
        if item['kind']!='custody':
            require(not any(x in target.lower() for x in ('orbita-access','orbita-restore','postgres-storage','operator.json','runtime.json','capability')),'LEGACY_CONTROL_CUSTODY_ONLY')
    ordered=sorted(targets)
    require(not any(b.startswith(a+'/') for a,b in zip(ordered,ordered[1:])),'LEGACY_TARGET_COLLISION')
    if version=='orbita-legacy-plan-2':
        from .legacy_metadata import check_derivations
        check_derivations(plan)
    serialize_plan(plan)
    binding,key=binding_for(destination,config);stage_binding,stage_key=binding_for(stage,config)
    require(binding==stage_binding and key and stage_key and key!=stage_key and not key.startswith(stage_key+'/') and not stage_key.startswith(key+'/'),'LEGACY_STAGE_SCOPE')
    # Bind the staging layout/version too. Older incomplete staging cannot be
    # silently resumed with a different custody or derivation algorithm.
    document=dict(importerVersion=3,plan=plan,instanceId=config.instance_id,workspaceId=binding.workspace_id,destination=key,stage=stage_key)
    return binding,key,stage_key,document,hashlib.sha256(stable(document)).hexdigest()


def verified_copy(files,key,source,length,*,progress):
    """Verify the full durable prefix, then append under revision CAS."""
    files.mkdir(key.rpartition('/')[0],parents=True,exist_ok=True)
    present=files.stat(key) if files.exists(key) else None
    offset=0
    if present:
        require(present['kind']=='file' and present['size']<=length,'LEGACY_RESUME_PREFIX_MISMATCH')
        with files.open_read(key) as saved:
            while offset<present['size']:
                take=min(BLOCK,present['size']-offset)
                require(saved.read(take)==source.read(take),'LEGACY_RESUME_PREFIX_MISMATCH');offset+=take
        if offset==length:
            require(source.read(1)==b'','LEGACY_SOURCE_LENGTH');return dict(size=length,sha256=present['sha256'],revision=present['revision'],objectId=present['objectId'])
    with files.open_write(key,append=present is not None,expected_revision=present['revision'] if present else 0) as writer:
        while offset<length:
            block=source.read(min(BLOCK,length-offset));require(bool(block),'LEGACY_SOURCE_LENGTH')
            writer.write(block);offset+=len(block)
            checkpoint=writer.checkpoint();progress(dict(event='durable-prefix',key=key,bytes=offset,total=length,**checkpoint))
        require(source.read(1)==b'','LEGACY_SOURCE_LENGTH')
        if length==0:writer.close()
        result=writer.result
    return result


def import_bundle(plan,destination,stage,*,config,limits=None,vector_extension=None,progress=lambda value:None,restore_context=None):
    limits=limits or Limits()
    binding,key,stage_key,document,plan_hash=checked_plan(plan,destination,stage,config)
    if restore_context is not None:
        require(isinstance(restore_context,dict) and set(restore_context)=={'id','snapshotId','sourceFormat','archiveSha256','archiveTreeHash','sourceRoot','restoredAt','originalValidation','archiveFiles','archiveBytes','archiveEntries'},'LEGACY_RESTORE_CONTEXT')
        require(restore_context['sourceFormat']=='orbita-memory-1' and len(stable(restore_context))<=16384,'LEGACY_RESTORE_CONTEXT')
        for field in ('id','snapshotId'):require(str(uuid.UUID(restore_context[field]))==restore_context[field],'LEGACY_RESTORE_CONTEXT')
        for field in ('archiveSha256','archiveTreeHash'):require(isinstance(restore_context[field],str) and re.fullmatch('[a-f0-9]{64}',restore_context[field]),'LEGACY_RESTORE_CONTEXT')
        for field in ('archiveFiles','archiveBytes','archiveEntries'):require(type(restore_context[field]) is int and restore_context[field]>=0,'LEGACY_RESTORE_CONTEXT')
        require(isinstance(restore_context['sourceRoot'],str) and Path(restore_context['sourceRoot']).is_absolute(),'LEGACY_RESTORE_CONTEXT')
        document=dict(document,restoreContext=restore_context);plan_hash=hashlib.sha256(stable(document)).hexdigest()
    native_root=Path(plan['sourceRoot'])
    with ExitStack() as stack:
        # Hold every source before any durable copy to keep the enumerated cut
        # immutable throughout a multi-file import. No native writes occur.
        owner=_guard_root(native_root,stack)
        held={item['source']:stack.enter_context(NativeReadHold(native_root/item['source'],item['sha256'])) for item in plan['entries']}
        stack.enter_context(StoreLease(destination,config=config,mode='exclusive'))
        stack.enter_context(StoreLease(stage,config=config,mode='exclusive'))
        files=stack.enter_context(ObjectStore(config,binding))
        require(not files.exists(key),'LEGACY_DESTINATION_EXISTS')
        files.mkdir(stage_key,parents=True,exist_ok=True)
        plan_key=stage_key+'/plan.json';raw_plan=stable(document)
        if files.exists(plan_key):require(files.read_bytes(plan_key)==raw_plan,'LEGACY_RESUME_PLAN_MISMATCH')
        else:
            require(files.listdir(stage_key)==[],'LEGACY_UNOWNED_STAGE')
            files.write_bytes(plan_key,raw_plan,exclusive=True)
        payload=stage_key+'/payload';files.mkdir(payload,exist_ok=True)
        receipts=[]
        for index,item in enumerate(plan['entries']):
            source=held[item['source']];source.file.seek(0)
            custody_relative='.orbita-legacy/originals/'+item['source']+'.bin'
            custody=payload+'/'+custody_relative
            copied=verified_copy(files,custody,source.file,source.identity.st_size,progress=progress)
            require(copied['sha256']==item['sha256'],'LEGACY_CUSTODY_HASH')
            target=payload+'/'+item['target'];receipt=dict(index=index,source=item['source'],sourceSha256=source.sha256,custodyPath=custody_relative,kind=item['kind'],target=item['target'])
            if item['kind']=='store':
                # Probe a fresh temporary locator. The probe is always rolled
                # back; it cannot publish an empty or partially imported store.
                probe=Path(binding.root)/(stage_key+'/probe-'+str(index))
                structure=installed_structure(probe,item['family'],config)
                with SqliteTransfer(source.path,source.sha256,family=item['family'],structure=structure,limits=limits,vector_extension=vector_extension) as stream:
                    stream_key=stage_key+'/streams/'+str(index)
                    staged=verified_copy(files,stream_key,stream,stream.size,progress=progress)
                    if files.exists(target):
                        with closing(Connection(Path(binding.root)/target,family=item['family'],config=config,read_only=True)) as restored:
                            require(restored.logical_manifest(limits=limits)==stream.manifest,'LEGACY_RESUME_STORE_MISMATCH')
                        result=stream.info
                    else:
                        result=import_object(Path(binding.root)/stream_key,0,stream.size,Path(binding.root)/target,config=config,limits=limits,
                                             expected_object_id=staged['objectId'],expected_revision=staged['revision'])
                    require(result==stream.info,'LEGACY_READBACK_MISMATCH')
                    receipt.update(result=result,provenance=stream.provenance)
            elif item['kind']=='file':
                files.mkdir(target.rpartition('/')[0],parents=True,exist_ok=True)
                if files.exists(target):
                    # Read all bytes, not just an untrusted stored hash.
                    source.file.seek(0);verified_copy(files,target,source.file,source.identity.st_size,progress=progress)
                else:files.copy_file(custody,target,exclusive=True)
            else:receipt['authorityRestored']=False
            receipts.append(receipt);source.verify();progress(dict(event='entry-verified',index=index,total=len(plan['entries'])))
        for source in held.values():source.verify()
        derived=[]
        if plan['schema']=='orbita-legacy-plan-2':
            from .legacy_metadata import materialize
            derived=materialize(plan,receipts,files,payload,key,config,binding,progress=progress)
        for source in held.values():source.verify()
        receipt=dict(schema='orbita-legacy-import-1',planSha256=plan_hash,instanceId=config.instance_id,workspaceId=binding.workspace_id,
                     destination=key,status='PASS_EXPLICIT_IMPORT',entries=receipts,derivations=derived,legacyOwner=owner,authorityRestored=False,humanAcceptance=False)
        if restore_context is not None:receipt['restoreContext']=restore_context
        receipt_key=payload+'/.orbita-legacy/receipt.json';files.mkdir(receipt_key.rpartition('/')[0],parents=True,exist_ok=True)
        raw_receipt=stable(receipt)
        if files.exists(receipt_key):require(files.read_bytes(receipt_key)==raw_receipt,'LEGACY_RESUME_RECEIPT_MISMATCH')
        else:files.write_bytes(receipt_key,raw_receipt,exclusive=True)
        files.mkdir(key.rpartition('/')[0],parents=True,exist_ok=True)
        progress(dict(event='before-promotion',planSha256=plan_hash))
        state=dict(schema='orbita-restore-2',id=str(uuid.uuid5(uuid.NAMESPACE_URL,'orbita-legacy:'+plan_hash)),sourceFormat=plan['schema'],planSha256=plan_hash)
        if restore_context is not None:state.update(restore_context)
        # Current control is established outside imported content, in the same
        # transaction as publication. A crash cannot expose auto-enabled data.
        with files.raw.transaction():
            files.raw.execute('SELECT orbita_common.prepare_restore(%s,%s)',(key,Jsonb(state)))
            files.rename(payload,key,replace=False)
        return receipt
