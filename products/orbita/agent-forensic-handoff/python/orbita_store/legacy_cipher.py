"""Authenticate v1 ciphertext to an unpublished PG object using owned Node.

Only after the whole GCM tag, source hash, transport and closure checks succeed
is the plaintext name published. No archive frame or SQLite content is parsed.
There is no native plaintext spool and no extra cryptography dependency.
"""
from contextlib import ExitStack
from pathlib import Path
import base64
import hashlib
import json
import os
import re
import struct
import subprocess
import threading
import time

from .config import binding_for,plain_local_path,require
from .legacy_sqlite import NativeReadHold
from .objects import ObjectStore,BLOCK

MAGIC=b'ORBITA-BACKUP-01\0'
HEADER=len(MAGIC)+28


def authenticate_archive(archive,expected_sha256,payload,*,config,node,password,storage='native',max_archive_bytes=50*1024**3,max_seconds=900):
    require(storage in ('native','postgresql-common'),'LEGACY_CIPHER_STORAGE')
    require(isinstance(expected_sha256,str) and re.fullmatch('[a-f0-9]{64}',expected_sha256),'LEGACY_EXPECTED_HASH_REQUIRED')
    require(type(max_archive_bytes) is int and HEADER+16<max_archive_bytes<=100*1024**3,'LEGACY_CIPHER_BYTE_BUDGET')
    require(type(max_seconds) in (int,float) and .05<=max_seconds<=21600,'LEGACY_CIPHER_DEADLINE_BUDGET')
    require(isinstance(password,str) and len(password)>=12 and len(password.encode('utf8'))<=4096,'LEGACY_CIPHER_PASSPHRASE')
    require(Path(node).is_absolute() and plain_local_path(node).is_file(),'LEGACY_CIPHER_NODE')
    target,target_key=binding_for(payload,config)
    require(bool(target_key),'LEGACY_CIPHER_PAYLOAD_PATH')
    deadline=time.monotonic()+max_seconds
    proc=None;timer=None;feeder=None;drainer=None;timed_out=threading.Event();stderr_overflow=threading.Event()
    feeding=[];errors=[];stderr=bytearray()
    with ExitStack() as stack:
        if storage=='native':
            source=stack.enter_context(NativeReadHold(archive,expected_sha256,max_bytes=max_archive_bytes))
            stream=source.file;size=source.identity.st_size
            verify_source=source.verify
            source_identity=dict(storage='native',sha256=source.sha256)
        else:
            origin,origin_key=binding_for(archive,config)
            require((origin.workspace_id,origin_key)!=(target.workspace_id,target_key),'LEGACY_CIPHER_OVERLAP')
            objects=stack.enter_context(ObjectStore(config,origin,read_only=True))
            stream=stack.enter_context(objects.open_read(origin_key));size=stream.item['size']
            require(size<=max_archive_bytes,'LEGACY_CIPHER_BYTE_BUDGET')
            source_identity=dict(storage=storage,objectId=stream.item['objectId'],revision=stream.item['revision'],sha256=expected_sha256)
            def verify_source():
                current=objects.stat(origin_key)
                require((current['objectId'],current['revision'])==(stream.item['objectId'],stream.item['revision']),'LEGACY_CIPHER_SOURCE_CHANGED')
        require(HEADER+16<size<=max_archive_bytes,'LEGACY_CIPHER_BYTE_BUDGET')
        header=stream.read(HEADER);stream.seek(size-16);tag=stream.read(16);stream.seek(HEADER)
        require(len(header)==HEADER and header[:len(MAGIC)]==MAGIC and len(tag)==16,'LEGACY_CIPHER_FORMAT')
        remaining=size-HEADER-16
        metadata=json.dumps(dict(password=password,header=base64.b64encode(header).decode('ascii'),tag=base64.b64encode(tag).decode('ascii'),bytes=remaining),ensure_ascii=False,separators=(',',':')).encode('utf8')
        require(len(metadata)<=8192,'LEGACY_CIPHER_METADATA_BUDGET')
        output=stack.enter_context(ObjectStore(config,target))
        output.mkdir(target_key.rpartition('/')[0],parents=True,exist_ok=True)
        require(not output.exists(target_key),'LEGACY_CIPHER_PAYLOAD_EXISTS')
        with output.open_write(target_key,exclusive=True) as writer:
            try:
                require(time.monotonic()<deadline,'LEGACY_CIPHER_DEADLINE')
                env={k:v for k,v in os.environ.items() if k.lower() in ('systemroot','windir','comspec','path','pathext','temp','tmp','lang','lc_all','tz')}
                command=[str(node),str(Path(__file__).with_suffix('.mjs'))]
                proc=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,creationflags=subprocess.CREATE_NO_WINDOW)
                def expire():
                    timed_out.set()
                    if proc.poll() is None:proc.kill()
                timer=threading.Timer(max(.001,deadline-time.monotonic()),expire);timer.daemon=True;timer.start()
                def feed():
                    try:
                        digest=hashlib.sha256(header);left=remaining
                        proc.stdin.write(struct.pack('>I',len(metadata))+metadata)
                        while left:
                            chunk=stream.read(min(BLOCK,left));require(bool(chunk),'LEGACY_CIPHER_TRUNCATED')
                            digest.update(chunk);proc.stdin.write(chunk);left-=len(chunk)
                        digest.update(tag);feeding.append(digest.hexdigest())
                        proc.stdin.close()
                    except BaseException:
                        errors.append('input')
                        try:proc.stdin.close()
                        except BaseException:pass
                        if proc.poll() is None:proc.kill()
                def drain():
                    try:
                        while chunk:=proc.stderr.read(4096):
                            if len(stderr)+len(chunk)>16384:
                                stderr_overflow.set()
                                if proc.poll() is None:proc.kill()
                            elif not stderr_overflow.is_set():stderr.extend(chunk)
                    except BaseException:errors.append('stderr')
                feeder=threading.Thread(target=feed,daemon=True);drainer=threading.Thread(target=drain,daemon=True)
                feeder.start();drainer.start();written=0
                while chunk:=proc.stdout.read(BLOCK):
                    written+=len(chunk);require(written<=remaining,'LEGACY_CIPHER_OUTPUT_BUDGET')
                    writer.write(chunk)
                code=proc.wait(timeout=5);feeder.join(5);drainer.join(5)
                require(not timed_out.is_set() and time.monotonic()<deadline,'LEGACY_CIPHER_DEADLINE')
                require(not feeder.is_alive() and not drainer.is_alive(),'LEGACY_CIPHER_TRANSPORT_NOT_CLOSED')
                require(not stderr_overflow.is_set(),'LEGACY_CIPHER_STDERR_BUDGET')
                require(code==0 and not errors and not stderr,'LEGACY_CIPHER_AUTHENTICATION_FAILED')
                require(feeding==[expected_sha256] and written==remaining,'LEGACY_CIPHER_SOURCE_OR_LENGTH_CHANGED')
                verify_source()
                require(time.monotonic()<deadline,'LEGACY_CIPHER_DEADLINE')
                writer.close()
                return dict(status='AUTHENTICATED_V1_PAYLOAD_ONLY',archiveSha256=expected_sha256,source=source_identity,payload=dict(path=str(payload),**writer.result),cryptoExit=code,cryptoProcessClosed=True,framesParsed=False)
            finally:
                if timer is not None:timer.cancel()
                if proc is not None:
                    if proc.poll() is None:proc.kill()
                    proc.wait(timeout=5)
                    for thread in (feeder,drainer):
                        if thread is not None:thread.join(5)
                    require(all(thread is None or not thread.is_alive() for thread in (feeder,drainer)),'LEGACY_CIPHER_TRANSPORT_NOT_CLOSED')
                    for pipe in (proc.stdin,proc.stdout,proc.stderr):
                        if pipe is not None:pipe.close()
