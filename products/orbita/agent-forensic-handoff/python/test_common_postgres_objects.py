"""Real immutable byte storage, bounded streams and scoped reclamation."""
from dataclasses import replace
from pathlib import Path
import hashlib
import io
import json
import os
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import psycopg

from orbita_store import StoreError
from orbita_store.admin import connect_operator, provision_workspace, install_object_protocol
from orbita_store.config import Binding, parse_config
from orbita_store.objects import ObjectStore, BLOCK


class CommonObjects(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.operator=json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_OPERATOR_CONFIG']).read_text(encoding='utf8'))
        cls.config=parse_config(json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_CONFIG']).read_text(encoding='utf8')))
        cls.run_id=str(uuid.uuid4());cls.fixture_ids=[]
        with connect_operator(cls.operator) as db:
            if db.execute('SELECT instance_id::text FROM orbita_common.identity').fetchone()[0]!=cls.config.instance_id:
                raise RuntimeError('TEST_INSTANCE_MISMATCH')
            install_object_protocol(db)

    def setUp(self):
        self.stores=[]
        value=provision_workspace(self.operator,label='qualification:'+self.run_id+':'+self._testMethodName,kind='test')
        self.fixture_ids.append(value['workspaceId'])
        self.binding=Binding(str(Path(os.environ['ORBITA_POSTGRES_TEST_ROOT'])/value['workspaceId']),value['workspaceId'],value['capability'])
        self.store=self.open_store()
        self.store.mkdir('')

    def open_store(self,**options):
        store=ObjectStore(self.config,self.binding,**options)
        self.stores.append(store);return store

    def tearDown(self):
        for store in self.stores:store.close()

    @classmethod
    def tearDownClass(cls):
        target=Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS'])/('fixtures-'+cls.run_id+'.json')
        target.write_text(json.dumps(dict(runId=cls.run_id,instanceId=cls.config.instance_id,workspaceIds=cls.fixture_ids),indent=2),encoding='utf8')

    def counts(self):
        return tuple(self.store.raw.execute('SELECT count(*) FROM orbita_common.'+table).fetchone()[0] for table in ['objects','object_chunks','chunk_blobs'])

    def test_original_bytes_large_stream_and_hash_exact(self):
        data=(b'\x00\xff UTF8 '+ 'á😀\r\n'.encode())*(BLOCK//4)
        with self.store.open_write('original',exclusive=True) as writer:
            for start in range(0,len(data),1379):writer.write(data[start:start+1379])
            self.assertLessEqual(len(writer.buffer),BLOCK)
        info=self.store.stat('original')
        self.assertEqual((info['size'],info['sha256']),(len(data),hashlib.sha256(data).hexdigest()))
        self.assertEqual(self.open_store().read_bytes('original'),data)
        self.assertFalse(Path(self.binding.root).exists())

    def test_text_reader_seek_and_eof_across_chunk_boundary(self):
        text='x'*(BLOCK-2)+'😀\r\nlínea siguiente\n'
        self.store.write_bytes('text',text.encode())
        with io.TextIOWrapper(io.BufferedReader(self.store.open_read('text')),encoding='utf8',newline='') as reader:
            self.assertEqual(reader.readline(),'x'*(BLOCK-2)+'😀\r\n')
            self.assertEqual(reader.read(),'línea siguiente\n')
        with self.store.open_read('text') as reader:
            reader.seek(-4,io.SEEK_END)
            self.assertEqual(reader.read(),text.encode()[-4:])
            reader.seek(0)
            self.assertEqual(reader.read(),text.encode())
            self.assertEqual(reader.read(),b'')

    def test_small_read_exact_bytes_empty_boundary_and_streaming_fallback(self):
        for index,value in enumerate([b'',b'\x00\xff'+ 'á😀\r\n'.encode(),b'z'*BLOCK,b'y'*(BLOCK+1)]):
            key='size-'+str(index);self.store.write_bytes(key,value)
            with self.open_store(read_only=True) as reader:
                self.assertEqual(reader.read_small(key),value if len(value)<=BLOCK else None)
                self.assertEqual(reader.read_bytes(key),value)
        with connect_operator(self.operator) as admin:
            self.assertEqual(admin.execute('SELECT count(*) FROM orbita_private.object_pins WHERE workspace_id=%s::uuid',(self.binding.workspace_id,)).fetchone()[0],0)

    def test_small_read_concurrent_replace_and_reclamation_never_mix_versions(self):
        values=[bytes([index])*65536 for index in range(13)]
        self.store.write_bytes('changing',values[0]);barrier=Barrier(2,timeout=15)
        def writer():
            with ObjectStore(self.config,self.binding) as store:
                for index in range(1,len(values)):
                    barrier.wait();store.write_bytes('changing',values[index]);barrier.wait()
        def reader():
            with ObjectStore(self.config,self.binding,read_only=True) as store:
                for index in range(1,len(values)):
                    barrier.wait()
                    for _ in range(3):self.assertIn(store.read_small('changing'),(values[index-1],values[index]))
                    barrier.wait()
        with ThreadPoolExecutor(max_workers=2) as pool:
            writing=pool.submit(writer);reading=pool.submit(reader)
            writing.result(timeout=30);reading.result(timeout=30)
        self.assertEqual(self.store.read_small('changing'),values[-1])
        self.assertEqual(self.counts(),(1,1,1))

    def test_small_read_preserves_kind_checks_workspace_isolation_and_freshness(self):
        self.store.write_bytes('value',b'original');self.store.mkdir('directory')
        with self.assertRaises(FileNotFoundError):self.store.read_small('missing')
        with self.assertRaises(IsADirectoryError):self.store.read_small('directory')
        self.store.session.open_store('relational','case',create=True)
        with self.assertRaisesRegex(StoreError,'LOGICAL_STORE_BYTES_NOT_AVAILABLE'):self.store.read_small('relational')
        other=provision_workspace(self.operator,label='qualification:'+self.run_id+':small-isolation',kind='test')
        self.fixture_ids.append(other['workspaceId'])
        binding=Binding(str(Path(self.binding.root)/'other'),other['workspaceId'],other['capability'])
        with ObjectStore(self.config,binding) as foreign:
            foreign.mkdir('')
            with self.assertRaises(FileNotFoundError):foreign.read_small('value')
        with self.open_store(read_only=True) as reader:
            self.assertEqual(reader.read_small('value'),b'original')
            self.store.write_bytes('value',b'changed')
            self.assertEqual(reader.read_small('value'),b'changed')
            self.store.unlink('value')
            with self.assertRaises(FileNotFoundError):reader.read_small('value')

    def test_unpublished_staging_is_invisible_and_exclusive_publish_is_atomic(self):
        reader=self.open_store()
        writer=self.store.open_write('new',exclusive=True);writer.write(b'first');writer.flush()
        self.assertFalse(reader.exists('new'))
        with reader.open_write('new',exclusive=True) as other:other.write(b'committed')
        with self.assertRaises(FileExistsError):writer.close()
        self.assertEqual(reader.read_bytes('new'),b'committed')
        self.assertEqual(self.counts(),(1,1,1))

    def test_pinned_reader_survives_replace_then_exact_gc(self):
        self.store.write_bytes('value',b'old bytes')
        old=self.store.stat('value')['objectId'];reader=self.open_store().open_read('value')
        self.store.write_bytes('value',b'new bytes')
        self.assertEqual(reader.read(),b'old bytes')
        self.assertEqual(self.open_store().read_bytes('value'),b'new bytes')
        self.assertEqual(self.store.collect([old]),0)
        reader.close()
        # Releasing the last live pin reclaims the retired version itself.
        self.assertEqual(self.store.collect([old]),0)
        self.assertEqual(self.counts(),(1,1,1))

    def test_completed_bytes_cannot_be_changed_or_erased_by_runtime(self):
        self.store.write_bytes('kept',b'original')
        oid=self.store.stat('kept')['objectId']
        for query,args in [
            ('UPDATE orbita_common.objects SET sha256=%s WHERE id=%s::uuid',('0'*64,oid)),
            ('DELETE FROM orbita_common.objects WHERE id=%s::uuid',(oid,)),
            ('UPDATE orbita_common.chunk_blobs SET bytes=%s',(b'changed',)),
            ('DELETE FROM orbita_common.object_chunks WHERE object_id=%s::uuid',(oid,)),
            ('INSERT INTO orbita_common.object_chunks(object_id,ordinal,chunk_hash) SELECT %s::uuid,1,sha256 FROM orbita_common.chunk_blobs',(oid,)),
        ]:
            with self.subTest(query=query):
                with self.assertRaises(psycopg.Error):self.store.raw.execute(query,args)
        self.assertEqual(self.store.read_bytes('kept'),b'original')

    def test_unfinished_and_inconsistent_objects_cannot_be_published(self):
        writer=self.store.open_write('value');writer.write(b'x')
        with self.assertRaises(psycopg.Error):
            self.store.raw.execute("INSERT INTO orbita_common.entries(path,kind,object_id) VALUES('bad','file',%s::uuid)",(writer.object_id,))
        with self.assertRaises(psycopg.Error):
            self.store.raw.execute('UPDATE orbita_common.objects SET complete=true,size=3,sha256=%s WHERE id=%s::uuid',('0'*64,writer.object_id))
        self.assertFalse(self.store.exists('bad'));writer.abort()
        self.assertEqual(self.counts(),(0,0,0))

    def test_append_keeps_original_bytes_and_rejects_lost_updates(self):
        original=b'a'*BLOCK+b'old partial'
        self.store.write_bytes('log',original)
        a=self.store.open_write('log',append=True)
        b=self.open_store().open_write('log',append=True)
        a.write(b'\nfirst');b.write(b'\nsecond');a.close()
        with self.assertRaisesRegex(StoreError,'REVISION_CONFLICT'):b.close()
        self.assertEqual(self.store.read_bytes('log'),original+b'\nfirst')
        self.assertEqual(self.counts(),(1,2,2))

    def test_small_write_sizes_exclusive_errors_and_pinned_previous_version(self):
        for value in (b'',b'\x00\xff'+ 'á😀\r\n'.encode(),b'x'*BLOCK):
            self.assertEqual(self.store.write_small("literal ' name",value),len(value))
            self.assertEqual(self.store.read_bytes("literal ' name"),value)
        reader=self.open_store().open_read("literal ' name")
        self.store.write_small("literal ' name",b'replacement')
        self.assertEqual(reader.read(),b'x'*BLOCK);reader.close()
        with self.assertRaises(FileExistsError):self.store.write_small("literal ' name",b'must not replace',exclusive=True)
        self.assertEqual(self.store.read_bytes("literal ' name"),b'replacement')
        self.store.mkdir('directory')
        with self.assertRaises(IsADirectoryError):self.store.write_small('directory',b'x')
        with self.assertRaises(FileNotFoundError):self.store.write_small('missing/file',b'x')
        with self.assertRaises(NotADirectoryError):self.store.write_small("literal ' name/child",b'x')

    def test_small_write_rolls_back_and_enforces_read_only_isolation_and_revocation(self):
        self.store.write_small('value',b'original');before=self.counts()
        with self.assertRaisesRegex(RuntimeError,'owned rollback'):
            with self.store.raw.transaction():
                with self.assertRaises(FileExistsError):self.store.write_small('value',b'forbidden',exclusive=True)
                self.store.write_small('value',b'rolled back')
                raise RuntimeError('owned rollback')
        self.assertEqual(self.store.read_bytes('value'),b'original');self.assertEqual(self.counts(),before)
        readonly=self.open_store(read_only=True)
        with self.assertRaises(StoreError):readonly.write_small('value',b'forbidden')
        with self.assertRaises(psycopg.Error):
            readonly.raw.execute('SELECT orbita_common.write_small_object(%s,%s,false)',('value',b'forbidden SQL'))
        other=provision_workspace(self.operator,label='qualification:'+self.run_id+':small-write-isolation',kind='test')
        self.fixture_ids.append(other['workspaceId'])
        binding=Binding(str(Path(self.binding.root)/'other'),other['workspaceId'],other['capability'])
        with ObjectStore(self.config,binding) as foreign:
            foreign.mkdir('');foreign.write_small('value',b'other workspace')
            self.assertEqual(foreign.read_bytes('value'),b'other workspace')
        self.assertEqual(self.store.read_bytes('value'),b'original')
        with connect_operator(self.operator) as operator:
            operator.execute('UPDATE orbita_private.workspaces SET active=false WHERE id=%s',(self.binding.workspace_id,))
        with self.assertRaises(FileNotFoundError):self.store.write_small('value',b'after revocation')

    def test_small_write_rejects_oversize_at_api_and_database_without_partial_state(self):
        self.store.write_small('kept',b'original');before=self.counts()
        with self.assertRaisesRegex(StoreError,'SMALL_WRITE_ARGUMENT'):self.store.write_small('kept',b'x'*(BLOCK+1))
        with self.assertRaises(psycopg.Error):
            self.store.raw.execute('SELECT orbita_common.write_small_object(%s,%s,false)',('kept',b'x'*(BLOCK+1)))
        for key in ('../escape','/absolute','with\\separator','control\x1f','colon:'):
            with self.assertRaises(psycopg.Error):
                self.store.raw.execute('SELECT orbita_common.write_small_object(%s,%s,false)',(key,b'invalid'))
        self.assertEqual(self.store.read_bytes('kept'),b'original');self.assertEqual(self.counts(),before)

    def test_small_write_concurrent_exclusive_creation_has_one_complete_winner(self):
        barrier=Barrier(2)
        def create(value):
            with ObjectStore(self.config,self.binding) as store:
                barrier.wait(timeout=10)
                try:store.write_small('exclusive-race',value,exclusive=True);return value
                except FileExistsError:return None
        values=[b'a'*BLOCK,b'b'*BLOCK]
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(create,values))
        winners=[value for value in results if value is not None]
        self.assertEqual(len(winners),1)
        self.assertEqual(self.store.read_bytes('exclusive-race'),winners[0])
        self.assertEqual(self.store.stat('exclusive-race')['revision'],1)
        self.assertEqual(self.counts(),(1,1,1))

    def test_identical_chunks_are_shared_and_reclaimed_only_after_last_name(self):
        data=b'x'*BLOCK+b'last'
        self.store.write_bytes('a',data);self.store.write_bytes('b',data)
        self.assertEqual(self.counts(),(2,4,2))
        self.store.unlink('a');self.assertEqual(self.counts(),(1,2,2))
        self.assertEqual(self.store.read_bytes('b'),data)
        self.store.unlink('b');self.assertEqual(self.counts(),(0,0,0))

    def test_directory_rename_is_atomic_without_copying_objects(self):
        self.store.mkdir('a%/nested',parents=True)
        self.store.write_bytes('a%/nested/file',b'bytes')
        oid=self.store.stat('a%/nested/file')['objectId']
        self.store.rename('a%','renamed')
        self.assertFalse(self.store.exists('a%/nested/file'))
        self.assertEqual(self.store.stat('renamed/nested/file')['objectId'],oid)
        self.assertEqual(self.store.listdir('renamed'),[dict(name='nested',kind='directory')])
        with self.assertRaisesRegex(StoreError,'RENAME_INTO_SELF'):self.store.rename('renamed','renamed/nested/child')
        with self.assertRaises(OSError):self.store.rmdir('renamed')
        self.store.unlink('renamed/nested/file');self.store.rmdir('renamed/nested');self.store.rmdir('renamed')

    def test_read_only_can_pin_but_cannot_write_or_collect(self):
        self.store.write_bytes('data',b'retained')
        ro=self.open_store(read_only=True)
        self.assertEqual(ro.read_bytes('data'),b'retained')
        for operation in [lambda:ro.write_bytes('data',b'changed'),lambda:ro.unlink('data'),lambda:ro.mkdir('x'),lambda:ro.collect([self.store.stat('data')['objectId']])]:
            with self.assertRaises(StoreError):operation()
        self.assertEqual(self.store.read_bytes('data'),b'retained')

    def test_path_escape_rejected_and_long_logical_names_do_not_touch_disk(self):
        directory='a'*180+'/'+'b'*150
        self.store.mkdir(directory,parents=True)
        self.store.write_bytes(directory+'/original',b'long-path bytes')
        self.assertEqual(self.store.read_bytes(directory+'/original'),b'long-path bytes')
        for path in ['../escape','a/../../escape','/absolute','C:/outside','a\\b']:
            with self.subTest(path=path):
                with self.assertRaises(StoreError):self.store.read_bytes(path)
        self.assertFalse(Path(self.binding.root).exists())

    def test_abort_and_store_close_discard_only_owned_unpublished_objects(self):
        self.store.write_bytes('retained',b'old')
        writer=self.store.open_write('retained');writer.write(b'new'*BLOCK);writer.abort()
        self.assertEqual(self.store.read_bytes('retained'),b'old')
        self.assertEqual(self.counts(),(1,1,1))
        other=self.open_store();other.open_write('never').write(b'x'*BLOCK);other.close()
        self.assertFalse(self.store.exists('never'));self.assertEqual(self.counts(),(1,1,1))

    def test_gc_drops_dead_backend_pin_but_not_live_references(self):
        self.store.write_bytes('data',b'bytes');oid=self.store.stat('data')['objectId']
        other=self.open_store();reader=other.open_read('data');pid=other.raw.info.backend_pid
        self.store.unlink('data');self.assertEqual(self.store.collect([oid]),0)
        with connect_operator(self.operator) as db:
            self.assertTrue(db.execute('SELECT pg_terminate_backend(%s)',(pid,)).fetchone()[0])
        with self.assertRaises(psycopg.Error):other.raw.execute('SELECT 1')
        reader.close()
        self.assertEqual(self.store.collect([oid]),1)
        self.assertEqual(self.counts(),(0,0,0))

    def test_full_read_detects_forged_claimed_digest(self):
        writer=self.store.open_write('bad');writer.write(b'actual bytes');writer._flush_block()
        oid=writer.object_id
        self.store.raw.execute('UPDATE orbita_common.objects SET complete=true,size=%s,sha256=%s WHERE id=%s::uuid',(len(b'actual bytes'),'0'*64,oid))
        self.store.raw.execute("INSERT INTO orbita_common.entries(path,kind,object_id) VALUES('bad','file',%s::uuid)",(oid,))
        self.store.raw.execute('SELECT orbita_common.unpin_object(%s::uuid)',(writer.pin,))
        writer.aborted=True;writer.abort()
        with self.assertRaisesRegex(StoreError,'OBJECT_HASH'):self.store.read_bytes('bad')

    def test_reclamation_skips_active_staging_and_cleans_dead_staging(self):
        other=self.open_store();writer=other.open_write('abandoned');writer.write(b'x'*BLOCK)
        oid=writer.object_id
        self.assertEqual(self.store.reclaim()['candidates'],[])
        pid=other.raw.info.backend_pid
        with connect_operator(self.operator) as db:
            self.assertTrue(db.execute('SELECT pg_terminate_backend(%s)',(pid,)).fetchone()[0])
        with self.assertRaises(psycopg.Error):other.raw.execute('SELECT 1')
        result=self.store.reclaim()
        self.assertEqual(result,dict(candidates=[oid],removed=1))
        self.assertEqual(self.counts(),(0,0,0))
        writer.abort()


if __name__=='__main__':unittest.main()
