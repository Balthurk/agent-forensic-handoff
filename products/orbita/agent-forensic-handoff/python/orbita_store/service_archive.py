"""Authenticated complete-service envelope, separate from workspace v1.

Uses the existing held native reader and Node builtin crypto. No plaintext
archive is written to native storage. Callers retain all members across both
authentication and restore; a consumer cannot start in the first pass.
"""
from contextlib import ExitStack
from pathlib import Path
import base64
import hashlib
import hmac
import json
import os
import secrets
import struct
import subprocess
import threading
import time
import uuid

from .config import plain_local_path, require
from .legacy_sqlite import NativeReadHold

MAGIC = b'ORBITA-SERVICE-BACKUP-02\0'
LIMIT = 50 * 1024**3
BLOCK = 1024**2
MEMBERS = ('globals.enc', 'database.enc')
MANIFEST_LIMIT = 16 * BLOCK


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf8')


def mac(key, value):
    return hmac.new(key[32:], canonical(value), hashlib.sha256).hexdigest()


def durable_json(path, value, *, exclusive=False):
    path = plain_local_path(path)
    if exclusive:
        with path.open('xb') as stream:
            stream.write(canonical(value) + b'\n'); stream.flush(); os.fsync(stream.fileno())
    else:
        stage = path.with_name(path.name + '.' + secrets.token_hex(8) + '.writing')
        with stage.open('xb') as stream:
            stream.write(canonical(value) + b'\n'); stream.flush(); os.fsync(stream.fileno())
        os.replace(stage, path)


def private_key(path, *, create=False):
    path = plain_local_path(path)
    if create:
        with path.open('xb') as stream:
            stream.write(secrets.token_bytes(64)); stream.flush(); os.fsync(stream.fileno())
    with NativeReadHold(path, max_bytes=64) as held:
        require(held.identity.st_size == 64, 'SERVICE_KEY_LENGTH')
        return held.file.read(64)


def _environment():
    return {k: v for k, v in os.environ.items() if k.lower() in
            ('systemroot', 'windir', 'comspec', 'path', 'pathext', 'temp', 'tmp', 'lang', 'lc_all', 'tz')}


def _crypt(source, sink, *, node, key, header, nonce, mode, deadline, size=None, tag=b'', limit=LIMIT, producer=None, consumer=None, bootstrap_role=None):
    """One bounded pump; all pipes drained and every owned process reaped."""
    require(len(key) == 64 and 0 <= limit <= LIMIT, 'SERVICE_CRYPTO_INPUT')
    require(time.monotonic() < deadline, 'SERVICE_DEADLINE')
    command = [str(plain_local_path(node)), str(Path(__file__).with_name('service_cipher.mjs'))]
    proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=_environment(), creationflags=subprocess.CREATE_NO_WINDOW)
    children = [p for p in (proc, producer, consumer) if p is not None]
    errors = []; diagnostics = []; threads = []; expired = threading.Event()
    def stop():
        for child in children:
            if child.poll() is None: child.kill()
    def expire():
        expired.set(); stop()
    def drain(child):
        count = 0
        try:
            while block := child.stderr.read(4096):
                count += len(block)
                if count > 16384: errors.append('stderr-budget'); stop()
        except BaseException: errors.append('stderr-transport'); stop()
        diagnostics.append((child, count))
    metadata = dict(mode=mode, key=base64.b64encode(key[:32]).decode(), header=base64.b64encode(header).decode(),
                    nonce=base64.b64encode(nonce).decode(), tag=base64.b64encode(tag).decode(), bytes=size, limit=limit, bootstrapRole=bootstrap_role)
    # Worker requires this fixed field order, not the manifest's sorted order.
    raw = json.dumps(metadata, separators=(',', ':')).encode()
    def feed():
        try:
            proc.stdin.write(struct.pack('>I', len(raw)) + raw); remaining = size
            while remaining is None or remaining:
                block = source.read(BLOCK if remaining is None else min(BLOCK, remaining))
                if not block:
                    require(remaining in (None, 0), 'SERVICE_MEMBER_TRUNCATED'); break
                proc.stdin.write(block)
                if remaining is not None: remaining -= len(block)
            proc.stdin.close()
        except BaseException: errors.append('input-transport'); stop()
    timer = threading.Timer(max(.001, deadline - time.monotonic()), expire); timer.daemon = True
    try:
        for child in children:
            thread = threading.Thread(target=drain, args=(child,), daemon=True); threads.append(thread); thread.start()
        feeder = threading.Thread(target=feed, daemon=True); threads.append(feeder); feeder.start(); timer.start()
        written = 0
        while block := proc.stdout.read(BLOCK):
            written += len(block); require(written <= limit + 16, 'SERVICE_OUTPUT_BUDGET')
            require(mode != 'authenticate', 'SERVICE_UNAUTHENTICATED_OUTPUT')
            sink.write(block)
        if consumer is not None: sink.close()
        for child in children: child.wait(timeout=max(.001, deadline - time.monotonic()))
        for thread in threads: thread.join(5)
        require(not expired.is_set() and time.monotonic() < deadline, 'SERVICE_DEADLINE')
        require(not errors and not any(t.is_alive() for t in threads), 'SERVICE_TRANSPORT')
        require(all(child.returncode == 0 for child in children), 'SERVICE_PROCESS_FAILED')
        require(not next((count for child, count in diagnostics if child is proc), 0), 'SERVICE_CRYPTO_FAILED')
        return written
    except subprocess.TimeoutExpired:
        expired.set()
        require(False, 'SERVICE_DEADLINE')
    finally:
        timer.cancel(); stop()
        for child in children: child.wait(timeout=5)
        for thread in threads: thread.join(5)
        for child in children:
            for pipe in (child.stdin, child.stdout, child.stderr):
                if pipe is not None:
                    try: pipe.close()
                    except OSError: pass
        require(not any(t.is_alive() for t in threads), 'SERVICE_TRANSPORT_NOT_CLOSED')


def encrypt_member(path, command, *, node, key, backup_id, instance_id, deadline, limit=LIMIT):
    path = plain_local_path(path); require(path.name in MEMBERS, 'SERVICE_MEMBER_NAME')
    nonce = secrets.token_bytes(12)
    value = dict(schema=2, backupId=str(uuid.UUID(backup_id)), instanceId=str(uuid.UUID(instance_id)), member=path.name, nonce=nonce.hex())
    encoded = canonical(value); header = MAGIC + struct.pack('>I', len(encoded)) + encoded
    require(len(header) <= 4096, 'SERVICE_HEADER_BUDGET')
    producer = None
    try:
        with path.open('xb') as sink:
            sink.write(header)
            producer = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                                        env=_environment(), creationflags=subprocess.CREATE_NO_WINDOW)
            count = _crypt(producer.stdout, sink, node=node, key=key, header=header, nonce=nonce, mode='encrypt',
                           deadline=deadline, producer=producer, limit=limit)
            sink.flush(); os.fsync(sink.fileno())
        with NativeReadHold(path, max_bytes=limit + 4112) as held:
            return dict(name=path.name, bytes=held.identity.st_size, sha256=held.sha256, header=value, plaintextBytes=count - 16)
    finally:
        if producer is not None and producer.poll() is None: producer.kill(); producer.wait(5)


class AuthenticatedServiceArchive:
    """Owns the same immutable handles until the second pass has completed."""
    def __init__(self, directory, *, key, node, deadline):
        self.stack = ExitStack(); self.members = {}; self.key = key; self.node = node; self.deadline = deadline
        self.directory = plain_local_path(directory)
        try:
            require({p.name for p in self.directory.iterdir()} == set(MEMBERS) | {'manifest.json'}, 'SERVICE_ARCHIVE_MEMBERS')
            manifest = self.stack.enter_context(NativeReadHold(self.directory / 'manifest.json', max_bytes=MANIFEST_LIMIT))
            value = json.loads(manifest.file.read().decode('utf8'))
            require(set(value) == {'payload', 'hmac'}, 'SERVICE_MANIFEST_FORMAT')
            require(hmac.compare_digest(mac(key, value['payload']), value['hmac']), 'SERVICE_MANIFEST_AUTHENTICATION')
            self.manifest = value['payload']; require(self.manifest['schema'] == 2, 'SERVICE_MANIFEST_SCHEMA')
            require([m['name'] for m in self.manifest['members']] == list(MEMBERS), 'SERVICE_MEMBER_LIST')
            for member in self.manifest['members']:
                held = self.stack.enter_context(NativeReadHold(self.directory / member['name'], member['sha256'], max_bytes=LIMIT + 4112))
                require(held.identity.st_size == member['bytes'], 'SERVICE_MEMBER_SIZE')
                prefix = held.file.read(len(MAGIC) + 4); require(prefix[:len(MAGIC)] == MAGIC, 'SERVICE_MEMBER_MAGIC')
                length = struct.unpack('>I', prefix[-4:])[0]; require(0 < length <= 4096 - len(prefix), 'SERVICE_HEADER_BUDGET')
                encoded = held.file.read(length); header = prefix + encoded; parsed = json.loads(encoded)
                require(parsed == member['header'] and canonical(parsed) == encoded, 'SERVICE_MEMBER_HEADER')
                require(parsed['schema'] == 2 and parsed['member'] == member['name'] and
                        parsed['backupId'] == self.manifest['backupId'] and parsed['instanceId'] == self.manifest['instanceId'], 'SERVICE_MEMBER_BINDING')
                size = held.identity.st_size - len(header) - 16
                require(0 <= size <= LIMIT and size == member['plaintextBytes'], 'SERVICE_MEMBER_SIZE')
                held.file.seek(-16, 2); tag = held.file.read(16); held.file.seek(len(header)); nonce = bytes.fromhex(parsed['nonce'])
                self.members[member['name']] = (held, header, nonce, size, tag)
            for name, (held, header, nonce, size, tag) in self.members.items():
                bootstrap=self.manifest.get('sourceBootstrapRole') if name=='globals.enc' else None
                _crypt(held.file, None, node=node, key=key, header=header, nonce=nonce, mode='authenticate', size=size, tag=tag, deadline=deadline,bootstrap_role=bootstrap)
                held.verify()
            self.authenticated = True
        except BaseException: self.stack.close(); raise

    def restore_member(self, name, command):
        require(self.authenticated and name in self.members, 'SERVICE_AUTHENTICATION_REQUIRED')
        held, header, nonce, size, tag = self.members[name]; held.verify(); held.file.seek(len(header))
        bootstrap=self.manifest.get('sourceBootstrapRole') if name=='globals.enc' else None
        omitted=len(('CREATE ROLE "'+bootstrap+'";\n').encode('utf8')) if bootstrap else 0
        consumer = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                    env=_environment(), creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            count = _crypt(held.file, consumer.stdin, node=self.node, key=self.key, header=header, nonce=nonce,
                           mode='decrypt', size=size, tag=tag, deadline=self.deadline, consumer=consumer,bootstrap_role=bootstrap)
            require(count == size-omitted, 'SERVICE_RESTORE_LENGTH'); held.verify()
            return dict(member=name, bytes=count, alreadyCreatedBootstrapBytes=omitted, consumerExit=consumer.returncode)
        finally:
            if consumer.poll() is None: consumer.kill(); consumer.wait(5)

    def close(self): self.stack.close()
    def __enter__(self): return self
    def __exit__(self, *unused): self.close()
