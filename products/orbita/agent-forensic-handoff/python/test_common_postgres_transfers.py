"""Real PG transfer/restore-control invariants, including adversarial archives."""
from dataclasses import replace
from pathlib import Path
import hashlib,io,json,struct,unittest,uuid
from unittest.mock import patch
import psycopg
from psycopg.types.json import Jsonb
import test_common_postgres_catalog as fixture
from orbita_store import StoreError,transfers
from orbita_store.admin import connect_operator,provision_workspace
from orbita_store.config import Binding
from orbita_store.connection import Connection
from orbita_store.objects import ObjectStore,BLOCK
from orbita_store.session import Session
from orbita_store.manifests import Limits
from orbita_store.transfers import StoreExport,import_stream,import_object,MAGIC,metadata

class CommonTransfers(unittest.TestCase):
    setUpClass=classmethod(fixture.CommonCatalogue.setUpClass.__func__)
    tearDownClass=classmethod(fixture.CommonCatalogue.tearDownClass.__func__)
    setUp=fixture.CommonCatalogue.setUp
    tearDown=fixture.CommonCatalogue.tearDown
    connect=fixture.CommonCatalogue.connect

    def path(self,key):return Path(self.binding.root)/key
    def seed(self):
        db=self.connect('embedding','source/cache')
        db.executescript((self.root/'embedding.sql').read_text(encoding='utf8'))
        db.execute('INSERT INTO vectors VALUES(?,?,?,?,?)',('model','one','literal ñ😀\\x41','[1,0]','hash'))
        db.execute('INSERT INTO vectors VALUES(?,?,?,?,?)',('model','deleted','old','[0,1]','hash2'))
        db.execute("DELETE FROM vectors WHERE text_hash='deleted'")
        return db
    def dump(self,key,**options):
        with StoreExport(self.path(key),config=self.config,**options) as stream:
            info=stream.info;parts=[]
            while chunk:=stream.read(7919):parts.append(chunk)
            raw=b''.join(parts);self.assertEqual(len(raw),info['size']);return raw,info
    def restore(self,raw,key='copy/cache',**options):
        return import_stream(io.BytesIO(raw),len(raw),self.path(key),config=self.config,**options)
    def absent(self,key):
        with ObjectStore(self.config,self.binding,read_only=True) as fs:self.assertFalse(fs.exists(key))
    def changed_header(self,raw,change):
        at=len(MAGIC);n=struct.unpack('>I',raw[at:at+4])[0];head=json.loads(raw[at+4:at+4+n]);change(head)
        return MAGIC+metadata(head)+raw[at+4+n:]
    def forged_metadata(self,raw,info,change):
        at=len(MAGIC);n=struct.unpack('>I',raw[at:at+4])[0];head=json.loads(raw[at+4:at+4+n]);change(head['shape'])
        ending=b'Z'+metadata(info['manifest']);self.assertTrue(raw.endswith(ending))
        forged=transfers.result_manifest(head['shape']['family'],info['manifest']['tables'],head['shape'])
        return MAGIC+metadata(head)+raw[at+4+n:-len(ending)]+b'Z'+metadata(forged)

    def test_literal_types_catalogue_deleted_counters_and_new_identity_round_trip(self):
        db=self.seed();before=db.logical_manifest();raw,info=self.dump('source/cache');result=self.restore(raw)
        self.assertEqual(info,result);self.assertEqual(result['manifest'],before)
        restored=self.connect('embedding','copy/cache');self.assertNotEqual(restored.session.store_id,db.session.store_id)
        self.assertEqual(restored.execute('SELECT rowid,* FROM vectors').fetchall(),db.execute('SELECT rowid,* FROM vectors').fetchall())
        self.assertEqual(restored.execute('INSERT INTO vectors VALUES(?,?,?,?,?)',('model','next','new','[]','h')).lastrowid,3)
        self.assertEqual(db.logical_manifest(),before)

    def test_every_installed_family_empty_catalogue_and_constraints_round_trip(self):
        for family,entry in self.manifest['families'].items():
            with self.subTest(family=family):
                db=self.connect(family,'original/'+family);db.executescript((self.root/entry['file']).read_text(encoding='utf8'))
                expected=db.logical_manifest();raw,info=self.dump('original/'+family)
                result=self.restore(raw,'restored/'+family);self.assertEqual(result['manifest'],expected)

    def test_blob_bigint_generated_rowids_vector_order_and_append_only_history(self):
        db=self.connect('vector','original/vector');raw_vector=struct.pack('<ff',1,0)
        for ordinal in (2**60,7,3):
            db.execute('INSERT INTO semantic_embedding VALUES(?,?,?,?,?,?)',(ordinal,str(ordinal),raw_vector,hashlib.sha256(raw_vector).hexdigest(),2,'now'))
            db.execute('INSERT INTO vector_index VALUES(?,?)',(ordinal,raw_vector))
        before=db.logical_manifest();raw,_=self.dump('original/vector');self.restore(raw,'restored/vector')
        restored=self.connect('vector','restored/vector');self.assertEqual(restored.logical_manifest(),before)
        query='SELECT rowid,_index_ordinal,embedding FROM orbita_vector.vector_index ORDER BY _index_ordinal'
        self.assertEqual(restored.raw.execute(query).fetchall(),db.raw.execute(query).fetchall())
        self.assertEqual(restored.execute('SELECT rowid FROM semantic_embedding ORDER BY rowid').fetchall(),[(3,),(7,),(2**60,)])
        semantic=self.connect('semantic','original/semantic');semantic.execute('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?,?)',('r','scope',1,'now','{"precise":9007199254740993}','h','req','rh'))
        raw,_=self.dump('original/semantic');self.restore(raw,'restored/semantic');copy=self.connect('semantic','restored/semantic')
        self.assertEqual(copy.logical_manifest(),semantic.logical_manifest())
        with self.assertRaises(psycopg.errors.CheckViolation):copy.execute("UPDATE record_versions SET payload='{}'")
        with self.assertRaises(psycopg.errors.ForeignKeyViolation):
            restored.raw.execute("INSERT INTO orbita_vector.semantic_chunk(id,content_hash,embedding_rowid,event_id,source_id,record_ordinal,evidence_uri,session_id,event_kind,chunk_index,text,text_sha256,redaction_state,created_at) VALUES('bad','h',999,'e','s',1,'u','s','event',0,'t','h','raw','now')")

    def test_export_stays_on_one_cut_during_concurrent_commit(self):
        db=self.seed();before=db.logical_manifest()
        with StoreExport(self.path('source/cache'),config=self.config) as stream:
            first=stream.read(17);db.execute("UPDATE vectors SET text='new cut'")
            parts=[first]
            while chunk:=stream.read(BLOCK):parts.append(chunk)
        result=self.restore(b''.join(parts));self.assertEqual(result['manifest'],before)
        self.assertNotEqual(db.logical_manifest(),before)

    def test_corruption_unknown_schema_truncation_extra_bytes_and_counter_regression_roll_back(self):
        self.seed();raw,info=self.dump('source/cache')
        corrupted=bytearray(raw);position=raw.index('literal ñ😀'.encode());corrupted[position]^=1
        invalid_shape=self.changed_header(raw,lambda h:h['shape']['tables'][0]['columns'][0].update(type='executable archive SQL'))
        invalid_counter=self.forged_metadata(raw,info,lambda shape:shape['counters'].update({'embedding.vectors':0}))
        invalid_catalogue=self.forged_metadata(raw,info,lambda shape:shape['catalogue'][0].update(source='DROP TABLE accounts'))
        for index,value in enumerate((raw[:-1],raw+b'x',bytes(corrupted),invalid_shape,invalid_counter,invalid_catalogue)):
            key='failed'+str(index)+'/cache'
            with self.subTest(index=index),self.assertRaises((StoreError,psycopg.Error)):self.restore(value,key)
            self.absent(key)
        self.assertEqual(self.restore(raw)['manifest']['rows'],1)

    def test_existing_destination_is_never_replaced(self):
        db=self.seed();before=db.logical_manifest();raw,_=self.dump('source/cache')
        with self.assertRaises(psycopg.errors.UniqueViolation):self.restore(raw,'source/cache')
        self.assertEqual(db.logical_manifest(),before)

    def test_export_and_import_budgets_fail_closed_without_partial_success(self):
        db=self.seed();db.execute('INSERT INTO vectors VALUES(?,?,?,?,?)',('m','other','payload','[]','h'))
        raw,_=self.dump('source/cache')
        for index,limit in enumerate((Limits(rows=1),Limits(bytes=1),Limits(field_bytes=1))):
            with self.subTest(index=index):
                with self.assertRaisesRegex(StoreError,'(MANIFEST|TRANSFER)_(ROW|BYTE|FIELD|LENGTH)_BUDGET'):self.dump('source/cache',limits=limit)
                with self.assertRaisesRegex(StoreError,'TRANSFER_(ROW|BYTE|FIELD|LENGTH)_BUDGET'):self.restore(raw,'limited'+str(index)+'/cache',limits=limit)
                self.absent('limited'+str(index)+'/cache')
        self.assertEqual(db.logical_manifest()['rows'],2)

    def test_real_server_deadline_cancels_export_and_connection_can_be_used_again(self):
        db=self.seed();original=transfers.manifest
        def delay(connection,**kwargs):
            connection.raw.execute('SELECT pg_sleep(3)');return original(connection,**kwargs)
        with patch.object(transfers,'manifest',delay),self.assertRaisesRegex(StoreError,'TRANSFER_DEADLINE'):
            StoreExport(self.path('source/cache'),config=self.config,limits=Limits(seconds=.2))
        self.assertEqual(db.logical_manifest()['rows'],1);self.assertEqual(self.dump('source/cache')[1]['manifest']['rows'],1)

    def test_common_object_slice_import_is_exact_and_foreign_authority_is_rejected(self):
        db=self.seed();text='😀ñ'.encode()*220000;db.execute('UPDATE vectors SET text=?',(text.decode(),));raw,info=self.dump('source/cache')
        with ObjectStore(self.config,self.binding) as fs:
            fs.mkdir('payloads');fs.write_bytes('payloads/authenticated',b'prefix'+raw+b'suffix')
            pinned=fs.stat('payloads/authenticated')
        result=import_object(self.path('payloads/authenticated'),6,len(raw),self.path('object-copy/cache'),config=self.config,
                             expected_object_id=pinned['objectId'],expected_revision=pinned['revision'])
        self.assertEqual(result,info)
        with ObjectStore(self.config,self.binding) as fs:fs.write_bytes('payloads/authenticated',b'prefix'+raw+b'suffix')
        with self.assertRaisesRegex(StoreError,'TRANSFER_SOURCE_REPLACED'):
            import_object(self.path('payloads/authenticated'),6,len(raw),self.path('replaced/cache'),config=self.config,expected_object_id=pinned['objectId'],expected_revision=pinned['revision'])
        self.absent('replaced/cache')
        with self.assertRaises(StoreError):import_object(self.path('payloads/authenticated'),6,len(raw)+100,self.path('bad-slice/cache'),config=self.config)
        self.absent('bad-slice/cache')
        value=provision_workspace(self.operator,label='qualification:'+self.run_id+':foreign',kind='test');self.fixture_ids.append(value['workspaceId'])
        forged=replace(self.binding,workspace_id=value['workspaceId']);config=replace(self.config,bindings=(forged,))
        with self.assertRaisesRegex(StoreError,'CONNECT_OR_AUTHORIZE'):StoreExport(self.path('source/cache'),config=config)

    def test_restore_controls_are_private_and_survive_content_clone_purge_and_recreation(self):
        with ObjectStore(self.config,self.binding) as fs:
            fs.mkdir('data',parents=True);fs.write_bytes('data/library.json',b'[]')
            state=dict(schema='orbita-restore-2',id=str(uuid.uuid4()),automaticWork=True,externalAccess=True)
            result=fs.raw.execute('SELECT orbita_common.prepare_restore(%s,%s)',('data',Jsonb(state))).fetchone()[0]
            self.assertFalse(result['automaticWork']);self.assertFalse(result['externalAccess'])
            fs.clone_tree('data','snapshot');fs.purge_tree('data',recursive=True);fs.mkdir('data');fs.write_bytes('data/library.json',b'[]')
            self.assertEqual(fs.raw.execute("SELECT orbita_common.restore_state('data')").fetchone()[0],result)
            self.assertIsNone(fs.raw.execute("SELECT orbita_common.restore_state('snapshot')").fetchone()[0])
            with self.assertRaisesRegex(psycopg.Error,'RESTORE_ID'):fs.raw.execute("SELECT orbita_common.activate_restore('data','wrong',true,true)")
            active=fs.raw.execute("SELECT orbita_common.activate_restore('data',%s,true,true)",(state['id'],)).fetchone()[0]
            self.assertTrue(active['externalAccess']);self.assertTrue(active['automaticWork'])
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):fs.raw.execute('DELETE FROM orbita_private.restore_controls')
        with connect_operator(self.operator) as op:
            self.assertEqual(op.execute('SELECT count(*) FROM orbita_private.restore_control_events WHERE workspace_id=%s',(self.binding.workspace_id,)).fetchone()[0],2)

    def test_readonly_and_revoked_workspace_cannot_create_or_activate_restore(self):
        with Session(self.config,self.binding,read_only=True) as read:
            read.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ')
            with self.assertRaises(psycopg.errors.ReadOnlySqlTransaction):read.raw.execute("SELECT orbita_common.begin_store_import('bad','embedding')")
            read.raw.rollback()
            with self.assertRaises(psycopg.errors.ReadOnlySqlTransaction):read.raw.execute("SELECT orbita_common.prepare_restore('data',%s)",(Jsonb({'schema':'orbita-restore-2','id':str(uuid.uuid4())}),))
        with Session(self.config,self.binding) as session:
            with connect_operator(self.operator) as op:op.execute('UPDATE orbita_private.workspaces SET active=false WHERE id=%s',(self.binding.workspace_id,))
            with self.assertRaises(psycopg.errors.InvalidAuthorizationSpecification):session.raw.execute("SELECT orbita_common.restore_state('data')")
            with self.assertRaises(psycopg.errors.ReadOnlySqlTransaction):session.raw.execute("SELECT orbita_common.activate_restore('data','none',true,true)")

    def test_early_export_close_releases_snapshot_without_replaying_or_publishing(self):
        db=self.seed();value=StoreExport(self.path('source/cache'),config=self.config);value.read(1);value.close();value.close()
        self.assertTrue(value.closed);self.assertFalse(value.done);self.assertFalse(value.budget.timer.is_alive())
        db.execute("UPDATE vectors SET text='fresh'");raw,_=self.dump('source/cache');self.restore(raw)
        self.assertEqual(self.connect('embedding','copy/cache').execute('SELECT text FROM vectors').fetchone(),('fresh',))

if __name__=='__main__':unittest.main()
