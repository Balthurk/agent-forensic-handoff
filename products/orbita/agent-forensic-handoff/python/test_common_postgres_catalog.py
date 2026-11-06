"""All installed application families and append-only history on real PG."""
from dataclasses import replace
from pathlib import Path
import json
import os
import unittest
import uuid

import psycopg

from orbita_store.admin import connect_operator,provision_workspace,install_object_protocol
from orbita_store.catalog import install_all
from orbita_store.config import Binding,parse_config
from orbita_store.connection import Connection
from orbita_store.objects import ObjectStore
from orbita_store import StoreError


class CommonCatalogue(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.operator=json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_OPERATOR_CONFIG']).read_text(encoding='utf8'))
        cls.config=parse_config(json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_CONFIG']).read_text(encoding='utf8')))
        cls.run_id=str(uuid.uuid4());cls.fixture_ids=[]
        cls.root=Path(__file__).parent/'orbita_store/schemas'
        cls.manifest=json.loads((cls.root/'manifest.json').read_text(encoding='utf8'))
        with connect_operator(cls.operator) as db:
            if db.execute('SELECT instance_id::text FROM orbita_common.identity').fetchone()[0]!=cls.config.instance_id:
                raise RuntimeError('TEST_INSTANCE_MISMATCH')
            install_object_protocol(db)
            cls.installation=install_all(db)
        (Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS'])/'catalogue-installation.json').write_text(json.dumps(cls.installation,indent=2),encoding='utf8')

    def setUp(self):
        self.connections=[]
        value=provision_workspace(self.operator,label='qualification:'+self.run_id+':'+self._testMethodName,kind='test')
        self.fixture_ids.append(value['workspaceId'])
        self.binding=Binding(str(Path(os.environ['ORBITA_POSTGRES_TEST_ROOT'])/value['workspaceId']),value['workspaceId'],value['capability'])
        self.config=replace(type(self).config,bindings=(self.binding,))

    def connect(self,family,key=None):
        db=Connection(Path(self.binding.root)/(key or family),family=family,config=self.config,create=True)
        self.connections.append(db);return db

    def tearDown(self):
        for db in self.connections:db.close()

    @classmethod
    def tearDownClass(cls):
        (Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS'])/('fixtures-'+cls.run_id+'.json')).write_text(json.dumps(dict(runId=cls.run_id,instanceId=cls.config.instance_id,workspaceIds=cls.fixture_ids),indent=2),encoding='utf8')

    def test_every_declared_family_binds_real_catalogue_with_forced_rls(self):
        self.assertEqual(len(self.manifest['families']),19)
        self.assertEqual(sum(f['tables'] for f in self.manifest['families'].values()),98)
        with connect_operator(self.operator) as db:
            rows=db.execute("SELECT n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname=ANY(%s)",(['orbita_'+f for f in self.manifest['families']],)).fetchall()
        self.assertEqual(len(rows),98)
        self.assertTrue(all(rls and force for _,_,rls,force in rows))
        for family,entry in self.manifest['families'].items():
            with self.subTest(family=family):
                db=self.connect(family)
                db.executescript((self.root/entry['file']).read_text(encoding='utf8'))
                self.assertEqual(db.execute("SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0],entry['tables'])
                db.close()

    def test_semantic_history_is_append_only_even_through_replace(self):
        db=self.connect('semantic')
        values=('r','scope',1,'2026-10-31T00:00:00Z','{}','hash','request','request-hash')
        db.execute('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?,?)',values)
        for sql,args in [('UPDATE record_versions SET payload=? WHERE record_id=?',('{"altered":true}','r')),
                         ('DELETE FROM record_versions WHERE record_id=?',('r',)),
                         ('INSERT OR REPLACE INTO record_versions VALUES(?,?,?,?,?,?,?,?)',values)]:
            with self.subTest(sql=sql):
                with self.assertRaises(psycopg.errors.CheckViolation):db.execute(sql,args)
        self.assertEqual(db.execute('SELECT rowid,payload,request_id FROM record_versions').fetchall(),[(1,'{}','request')])
        self.assertEqual(self.connect('semantic','other').execute('SELECT count(*) FROM record_versions').fetchone(),(0,))

    def test_corpus_bindings_vector_bytes_and_volume_ordinals_remain_exact(self):
        corpus=self.connect('corpus')
        corpus.execute('INSERT INTO source_bindings VALUES(?,?,?,?,?)',('source','revision','{"literal":"á😀"}','digest','now'))
        with self.assertRaises(psycopg.errors.CheckViolation):corpus.execute("UPDATE source_bindings SET digest='changed'")
        vector=self.connect('vector')
        raw=b'\x00\x00\x80\x3f\x00\x00\x00\x00'
        vector.execute('INSERT INTO semantic_embedding VALUES(?,?,?,?,?,?)',(7,'text-hash',raw,'vector-hash',2,'now'))
        vector.execute('INSERT INTO vector_index VALUES(?,?)',(7,raw))
        self.assertEqual(vector.execute('SELECT rowid,embedding FROM vector_index').fetchone(),(7,raw))
        volume=self.connect('volume')
        volume.execute('INSERT INTO records VALUES(?,?,?,?,?,?,?)',(99,'source','afh://source/1','event','línea😀','{}','row-hash'))
        self.assertEqual(volume.execute('SELECT seq,rowid,raw,length(CAST(raw AS BLOB)) FROM records').fetchone(),(99,99,'línea😀',len('línea😀'.encode())))

    def test_rename_moves_rows_and_bytes_without_changing_open_store_identity(self):
        original=self.connect('embedding','case-a/cache.pgstore')
        original.execute('INSERT INTO vectors VALUES(?,?,?,?,?)',('model','hash','literal','[1,2]','vhash'))
        identity=original.session.store_id
        with ObjectStore(self.config,self.binding) as files:
            self.assertTrue(files.exists('case-a/cache.pgstore'))
            files.write_bytes('case-a/original',b'original bytes')
            reader=files.open_read('case-a/original')
            files.rename('case-a','case-b')
            self.assertFalse(files.exists('case-a'))
            self.assertEqual(files.read_bytes('case-b/original'),b'original bytes')
            self.assertEqual(reader.read(),b'original bytes');reader.close()
            current=self.connect('embedding','case-b/cache.pgstore')
            self.assertEqual(current.session.store_id,identity)
            self.assertEqual(original.execute('SELECT text FROM vectors').fetchone(),('literal',))
            self.assertEqual(current.execute('SELECT text FROM vectors').fetchone(),('literal',))
            with self.assertRaises(StoreError):
                Connection(Path(self.binding.root)/'case-a/cache.pgstore',family='embedding',config=self.config,read_only=True)

    def test_file_and_store_locator_conflict_rolls_back_without_aliases(self):
        with ObjectStore(self.config,self.binding) as files:
            files.mkdir('');files.write_bytes('already-file',b'bytes')
            with self.assertRaises(StoreError):self.connect('embedding','already-file')
            self.assertEqual(files.read_bytes('already-file'),b'bytes')
            db=self.connect('embedding','store-a')
            with self.assertRaises(psycopg.Error):
                files.raw.execute("INSERT INTO orbita_common.entries(path,kind,store_id) VALUES('alias','store',%s::uuid)",(db.session.store_id,))
            self.assertFalse(files.exists('alias'))


if __name__=='__main__':unittest.main()
