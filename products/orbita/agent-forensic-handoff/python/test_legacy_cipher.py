"""Real v1 writer, transport faults and authenticated-only publication."""
from dataclasses import replace
from pathlib import Path
import hashlib
import json
import os
import subprocess
import time
import unittest
from unittest.mock import patch
import uuid

from orbita_store import StoreError
from orbita_store.admin import connect_operator,provision_workspace
from orbita_store.config import Binding,parse_config
from orbita_store.legacy_cipher import authenticate_archive
from orbita_store.objects import ObjectStore,ObjectWriter
from orbita_store.pool import close_idle

REAL_POPEN=subprocess.Popen
PASSWORD='synthetic-legacy-cipher-password-only'
SHA=lambda value:hashlib.sha256(value).hexdigest()


class LegacyCipher(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.operator=json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_OPERATOR_CONFIG']).read_text())
        cls.base=parse_config(json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_CONFIG']).read_text()))
        cls.node=Path(os.environ['ORBITA_TEST_NODE']);cls.run_id=str(uuid.uuid4());cls.ids=[]
        cls.native=Path(os.environ['TEMP'])/('legacy-cipher-'+cls.run_id)
        command=[str(cls.node),str(Path(__file__).resolve().parents[2]/'app/legacy-cipher-producer-fixture.mjs'),os.environ['ORBITA_TEST_I05_ORACLE'],str(cls.native)]
        env={k:v for k,v in os.environ.items() if k.lower() in ('systemroot','windir','comspec','path','pathext','temp','tmp','lang','lc_all','tz')}
        owned=REAL_POPEN(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,creationflags=subprocess.CREATE_NO_WINDOW)
        try:stdout,stderr=owned.communicate(timeout=45)
        finally:
            if owned.poll() is None:owned.kill();owned.wait(5)
        if owned.returncode:raise AssertionError('ORIGINAL_WRITER_FAILED: '+stderr.decode('utf8'))
        cls.reference=json.loads(stdout);assert cls.reference['originalWriter']
        cls.archive=cls.native/'archive.orbita'
        cls.native_before={str(p):SHA(p.read_bytes()) for p in cls.native.rglob('*') if p.is_file()}

    @classmethod
    def tearDownClass(cls):
        close_idle()
        (Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS'])/('fixtures-cipher-'+cls.run_id+'.json')).write_text(json.dumps(dict(workspaceIds=cls.ids)))

    def setUp(self):
        value=provision_workspace(self.operator,label='qualification:'+self.run_id+':legacy-cipher',kind='test')
        self.ids.append(value['workspaceId']);self.root=Path(os.environ['ORBITA_POSTGRES_TEST_ROOT'])/value['workspaceId']
        self.binding=Binding(str(self.root),value['workspaceId'],value['capability']);self.config=replace(self.base,bindings=(self.binding,));self.children=[]
        self.payload=self.root/'authenticated/payload';self.source=self.archive;self.expected=self.reference['archiveSha256']

    def tearDown(self):
        for child in self.children:self.assertIsNotNone(child.poll(),'OWNED_CIPHER_PROCESS_LIVE')
        self.assertFalse(self.root.exists(),'NATIVE_OPERATIONAL_OUTPUT')
        self.assertEqual({name:SHA(Path(name).read_bytes()) for name in self.native_before},self.native_before)
        close_idle()

    def call(self,**options):
        return authenticate_archive(self.source,self.expected,self.payload,config=self.config,node=self.node,password=options.pop('password',PASSWORD),**options)

    def spawn(self,command,**options):
        self.assertNotIn(PASSWORD,json.dumps(command));self.assertNotIn(PASSWORD,json.dumps(options.get('env',{})))
        child=REAL_POPEN(command,**options);self.children.append(child);return child

    def broken_child(self,program):
        return patch('orbita_store.legacy_cipher.subprocess.Popen',side_effect=lambda command,**options:self.spawn([str(self.node),'-e',program],**options))

    def absent(self):
        close_idle()
        with ObjectStore(self.config,self.binding) as objects:
            self.assertFalse(objects.exists('authenticated/payload'))
            self.assertEqual(objects.raw.execute('SELECT count(*) FROM orbita_common.objects WHERE NOT complete').fetchone()[0],0)
            self.assertEqual(objects.raw.execute('SELECT count(*) FROM orbita_common.entries WHERE kind=\'file\' AND path<>\'cipher\'').fetchone()[0],0)

    def verify(self,result,sha=None,size=None):
        self.assertEqual(result['status'],'AUTHENTICATED_V1_PAYLOAD_ONLY');self.assertFalse(result['framesParsed']);self.assertTrue(result['cryptoProcessClosed'])
        with ObjectStore(self.config,self.binding) as objects:
            value=objects.read_bytes('authenticated/payload')
            self.assertEqual(SHA(value),sha or self.reference['payloadSha256'])
            if size is not None:self.assertEqual(len(value),size)
        self.assertEqual(result['cryptoExit'],0)

    def pg_source(self,bytes=None):
        with ObjectStore(self.config,self.binding) as objects:
            objects.mkdir('',exist_ok=True);objects.write_bytes('cipher',self.archive.read_bytes() if bytes is None else bytes)
        self.source=self.root/'cipher'

    def altered(self,value):
        file=Path(os.environ['TEMP'])/('cipher-mutant-'+str(uuid.uuid4())+'.orbita');file.write_bytes(value)
        self.source=file;self.expected=SHA(value)

    def test_original_writer_streams_multiple_blocks_native_without_spool(self):
        with patch('orbita_store.legacy_cipher.subprocess.Popen',side_effect=self.spawn):result=self.call()
        self.verify(result,size=self.reference['payloadBytes']);self.assertEqual(len(self.children),1)
        self.assertEqual({str(p) for p in self.native.rglob('*') if p.is_file()},set(self.native_before))

    def test_original_writer_from_pinned_postgres_ciphertext(self):
        self.pg_source();self.verify(self.call(storage='postgresql-common'));self.assertTrue(self.source.parent==self.root)

    def test_authenticated_bytes_are_not_parsed_as_frames(self):
        self.source=self.native/'opaque.orbita';self.expected=self.reference['opaqueSha256']
        self.verify(self.call(),sha=self.reference['opaquePayloadSha256'],size=6)

    def test_wrong_password_never_publishes(self):
        with self.assertRaisesRegex(StoreError,'AUTHENTICATION_FAILED'):self.call(password=PASSWORD+'wrong')
        self.absent()

    def test_wrong_tag_never_publishes(self):
        value=bytearray(self.archive.read_bytes());value[-1]^=1;self.altered(value)
        with self.assertRaisesRegex(StoreError,'AUTHENTICATION_FAILED'):self.call()
        self.absent()

    def test_changed_cipher_body_never_publishes(self):
        value=bytearray(self.archive.read_bytes());value[65]^=1;self.altered(value)
        with self.assertRaisesRegex(StoreError,'AUTHENTICATION_FAILED'):self.call()
        self.absent()

    def test_truncated_cipher_never_publishes(self):
        self.altered(self.archive.read_bytes()[:-12])
        with self.assertRaisesRegex(StoreError,'AUTHENTICATION_FAILED'):self.call()
        self.absent()

    def test_native_expected_hash_rejected_before_child(self):
        self.expected='0'*64
        with patch('orbita_store.legacy_cipher.subprocess.Popen',side_effect=self.spawn),self.assertRaisesRegex(StoreError,'SOURCE_HASH'):self.call()
        self.assertEqual(self.children,[]);self.absent()

    def test_postgres_expected_hash_rejected_before_publication(self):
        self.pg_source();self.expected='0'*64
        with self.assertRaisesRegex(StoreError,'SOURCE_OR_LENGTH_CHANGED'):self.call(storage='postgresql-common')
        self.absent()

    def test_wrong_magic_rejected_before_child(self):
        self.altered(b'x'+self.archive.read_bytes()[1:])
        with patch('orbita_store.legacy_cipher.subprocess.Popen',side_effect=self.spawn),self.assertRaisesRegex(StoreError,'CIPHER_FORMAT'):self.call()
        self.assertEqual(self.children,[]);self.absent()

    def test_archive_quota_rejected_before_child(self):
        with patch('orbita_store.legacy_cipher.subprocess.Popen',side_effect=self.spawn),self.assertRaisesRegex(StoreError,'BYTE_BUDGET'):self.call(max_archive_bytes=1024)
        self.assertEqual(self.children,[]);self.absent()

    def test_native_read_hold_blocks_write_and_delete_during_child(self):
        def spawn(command,**options):
            with self.assertRaises(PermissionError):self.archive.open('r+b')
            with self.assertRaises(PermissionError):self.archive.unlink()
            return self.spawn(command,**options)
        with patch('orbita_store.legacy_cipher.subprocess.Popen',side_effect=spawn):self.verify(self.call())

    def test_postgres_replacement_while_pinned_rejected(self):
        self.pg_source()
        def spawn(command,**options):
            with ObjectStore(self.config,self.binding) as objects:objects.write_bytes('cipher',b'new-version')
            return self.spawn(command,**options)
        with patch('orbita_store.legacy_cipher.subprocess.Popen',side_effect=spawn),self.assertRaisesRegex(StoreError,'SOURCE_CHANGED'):self.call(storage='postgresql-common')
        self.absent()

    def test_early_child_exit_closes_all_pipes_and_aborts(self):
        with self.broken_child('process.exit(77)'),self.assertRaisesRegex(StoreError,'AUTHENTICATION_FAILED'):self.call()
        self.absent()

    def test_deadline_kills_only_held_child_and_aborts(self):
        started=time.monotonic()
        with self.broken_child('setInterval(()=>{},1000)'),self.assertRaisesRegex(StoreError,'CIPHER_DEADLINE'):self.call(max_seconds=1.5)
        self.assertLess(time.monotonic()-started,8);self.assertEqual(len(self.children),1);self.absent()

    def test_stderr_is_bounded_and_cannot_disclose_child_content(self):
        with self.broken_child("process.stderr.write('secret-marker'.repeat(5000));setInterval(()=>{},1000)"),self.assertRaises(StoreError) as raised:self.call()
        self.assertNotIn('secret-marker',str(raised.exception));self.absent()

    def test_excess_plaintext_rejected_and_child_closed(self):
        with self.broken_child('process.stdout.write(Buffer.alloc(4*1024**2));setInterval(()=>{},1000)'),self.assertRaisesRegex(StoreError,'OUTPUT_BUDGET'):self.call()
        self.absent()

    def test_downstream_database_write_failure_closes_crypto_child(self):
        with patch('orbita_store.legacy_cipher.subprocess.Popen',side_effect=self.spawn),patch.object(ObjectWriter,'write',side_effect=OSError('synthetic output failure')),self.assertRaisesRegex(OSError,'synthetic output failure'):self.call()
        self.assertEqual(len(self.children),1);self.absent()

    def test_existing_output_is_not_replaced(self):
        with ObjectStore(self.config,self.binding) as objects:objects.mkdir('authenticated',parents=True);objects.write_bytes('authenticated/payload',b'preserved')
        with self.assertRaisesRegex(StoreError,'PAYLOAD_EXISTS'):self.call()
        with ObjectStore(self.config,self.binding) as objects:self.assertEqual(objects.read_bytes('authenticated/payload'),b'preserved')

    def test_source_and_payload_cannot_be_same_postgres_name(self):
        self.pg_source();self.payload=self.source
        with self.assertRaisesRegex(StoreError,'OVERLAP'):self.call(storage='postgresql-common')
        with ObjectStore(self.config,self.binding) as objects:self.assertEqual(SHA(objects.read_bytes('cipher')),self.expected)
