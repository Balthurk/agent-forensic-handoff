"""Operator publication, frozen staging, original control and archive isolation."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime,timedelta,timezone
from pathlib import Path
import hashlib
import json
import os
import subprocess
import threading
import time
import unittest
import uuid
import psycopg

from orbita_store import StoreError
from orbita_store.admin import connect_operator,provision_workspace
from orbita_store.config import Binding,parse_config
from orbita_store.connection import Connection
from orbita_store.objects import ObjectStore
from orbita_store.pool import close_idle
from orbita_store.schema import install_family
from orbita_store.session import Session
from orbita_store.managed_migration import stage_manifest,freeze_stages,publish_domain,publication_receipt,import_access_snapshot

SCHEMAS=Path(__file__).parent/'orbita_store/schemas'


class ManagedMigration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.operator=json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_OPERATOR_CONFIG']).read_text())
        cls.base=parse_config(json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_CONFIG']).read_text()))
        cls.run_id=str(uuid.uuid4());cls.ids=[]
        with connect_operator(cls.operator) as db:
            install_family(db,'access',(SCHEMAS/'access.sql').read_text())
            install_family(db,'semantic',(SCHEMAS/'semantic.sql').read_text())

    def setUp(self):self.owned=[]
    def keep(self,value):self.owned.append(value);return value
    def close_all(self):
        for obj in reversed(self.owned):obj.close()
        self.owned=[];close_idle()
    def tearDown(self):self.close_all()
    @classmethod
    def tearDownClass(cls):
        close_idle()
        (Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS'])/('fixtures-'+cls.run_id+'.json')).write_text(json.dumps(dict(workspaceIds=cls.ids)))

    def personal(self):
        value=provision_workspace(self.operator,label='qualification:'+self.run_id+':managed-migration',kind='personal')
        self.ids.append(value['workspaceId'])
        return Binding(str(Path(os.environ['ORBITA_POSTGRES_TEST_ROOT'])/value['workspaceId']),value['workspaceId'],value['capability'])

    def connection(self,binding,key='control/access.pgstore',family='access',create=False):
        return self.keep(Connection(Path(binding.root)/key,family=family,config=replace(self.base,bindings=(binding,)),create=create))

    def domain(self,*,expired=False,purged=False,archive=True,local=None,archive_id=None):
        parent=self.personal();child=self.personal();local=local or 'ws-'+str(uuid.uuid4())
        control=self.connection(parent,create=True);control.executescript((SCHEMAS/'access.sql').read_text())
        control.execute("INSERT INTO users VALUES('owner','original-name','original-salt','original-derived-password',1,1,7)")
        control.execute("INSERT INTO sessions VALUES('original-expired-session','owner',7,1,1,'browser',?)",(local,))
        date=lambda days:(datetime.now(timezone.utc)+timedelta(days=days)).isoformat(timespec='milliseconds').replace('+00:00','Z')
        body=dict(id=local,owner='owner',name='Original',revision=9,status='purged' if purged else 'active',policy={} if purged else dict(rightsUntil=date(-2 if expired else 2),retainUntil=date(-1 if expired else 3)),legalHold=False,externalCopies=[])
        if purged:body['purge']=dict(id=str(uuid.uuid4()),workspace=local,managedFilesAbsent=True,physicalErasure=False,scope='managed_workspace_only',files=2,bytes=12,treeHash='legacy-hash',at=date(-1))
        raw=json.dumps(body,ensure_ascii=False,indent=2)
        control.execute('INSERT INTO workspaces VALUES(?,?,?)',(local,9,raw))
        control.execute("INSERT INTO members VALUES(?,'owner','owner',4)",(local,))
        control.execute("INSERT INTO audit VALUES(31,'original-time','owner','legacy_action',?,'{\"original\":true}')",(local,))
        store=self.keep(ObjectStore(self.base,child));store.mkdir('',exist_ok=True)
        value=None
        if not purged:
            store.mkdir('data');store.write_bytes('data/library.json',b'[]');store.write_bytes('data/preserved.bin',b'original\x00bytes')
            content=self.connection(child,'data/semantic/records.pgstore','semantic',True)
            content.executescript((SCHEMAS/'semantic.sql').read_text())
            content.execute("INSERT INTO record_versions VALUES('record','scope',3,'old-time','{}','old-hash','old-request','old-request-hash')")
        if archive and not purged:
            aid=archive_id or str(uuid.uuid4());cipher=b'original opaque ciphertext\x00'+aid.encode()
            store.mkdir('backups');store.write_bytes('backups/'+aid+'.orbita',cipher)
            value=dict(id=aid,workspace=local,archive='C:\\original\\access\\spaces\\'+local+'\\backups\\'+aid+'.orbita',sha256=hashlib.sha256(cipher).hexdigest(),bytes=17,files=1,createdAt='original-time')
            control.execute('INSERT INTO archives VALUES(?,?,?)',(aid,local,json.dumps(value,indent=2)))
        spec=dict(instance_id=self.base.instance_id,control=parent.workspace_id,children={local:child.workspace_id})
        request=dict(**spec,operation_id=str(uuid.uuid4()),control_store=control.session.store_id)
        return dict(parent=parent,child=child,local=local,control=control,store=store,body=body,raw=raw,archive=value,spec=spec,request=request)

    def ready(self,d):
        self.close_all();d['request']['manifest']=stage_manifest(self.operator,**d['spec'])
        freeze_stages(self.operator,**d['spec']);return d
    def publish(self,d):return publish_domain(self.operator,**d['request'])
    def rebound(self,binding):
        with connect_operator(self.operator) as db:
            value=db.execute('SELECT capability_secret FROM orbita_private.workspaces WHERE id=%s',(binding.workspace_id,)).fetchone()[0]
        return replace(binding,capability=value)
    def fresh_control(self,d):return self.connection(self.rebound(d['parent']))
    def state(self,d):
        with connect_operator(self.operator) as db:
            return db.execute('SELECT kind,active FROM orbita_private.workspaces WHERE id=ANY(%s::uuid[]) ORDER BY id',([d['parent'].workspace_id,d['child'].workspace_id],)).fetchall()

    def test_preserves_control_rows_and_expired_rights_rotates_staging(self):
        d=self.domain(expired=True);self.ready(d);receipt=self.publish(d)
        self.assertFalse(receipt['automaticWork']);self.assertFalse(receipt['externalAccess'])
        for old in (d['parent'],d['child']):
            with self.assertRaises(StoreError):Session(self.base,old)
        control=self.fresh_control(d)
        self.assertEqual(control.execute('SELECT revision,payload,rowid FROM workspaces').fetchone(),(9,d['raw'],1))
        self.assertEqual(control.execute('SELECT salt,password,epoch FROM users').fetchone(),('original-salt','original-derived-password',7))
        self.assertEqual(control.execute('SELECT hash,expires,epoch FROM sessions').fetchone(),('original-expired-session',1,7))
        self.assertEqual(control.execute('SELECT revision FROM members').fetchone(),(4,))
        self.assertEqual(control.execute('SELECT seq,rowid FROM audit').fetchone(),(31,31))
        with self.assertRaisesRegex(psycopg.Error,'MANAGED_INACTIVE'):
            control.raw.execute("SELECT orbita_common.managed_binding(%s,'worker')",(d['local'],))
        details=control.raw.execute("SELECT orbita_common.managed_binding(%s,'maintenance')",(d['local'],)).fetchone()[0]
        child=replace(d['child'],capability=details['capability'])
        obj=self.keep(ObjectStore(self.base,child));self.assertEqual(obj.read_bytes('data/preserved.bin'),b'original\x00bytes')
        content=self.connection(child,'data/semantic/records.pgstore','semantic')
        self.assertEqual(content.execute('SELECT record_id,version,rowid FROM record_versions').fetchone(),('record',3,1))

    def test_manifest_change_rejects_atomically_and_leaves_frozen(self):
        d=self.domain();self.close_all();d['request']['manifest']=stage_manifest(self.operator,**d['spec'])
        changed=self.connection(d['parent']);changed.execute('UPDATE users SET epoch=99')
        self.close_all();freeze_stages(self.operator,**d['spec'])
        with connect_operator(self.operator) as db,self.assertRaises(psycopg.errors.InsufficientPrivilege):
            db.execute('UPDATE orbita_access.users SET epoch=100 WHERE _store_id=%s',(d['request']['control_store'],))
        with self.assertRaisesRegex(StoreError,'MIGRATION_MANIFEST_CHANGED'):self.publish(d)
        self.assertEqual(self.state(d),[('personal',False)]*2)
        self.assertIsNone(publication_receipt(self.operator,instance_id=self.base.instance_id,operation_id=d['request']['operation_id']))

    def test_freeze_reports_live_consumer_keeps_denial_without_killing(self):
        d=self.domain();self.close_all()
        session=self.keep(Session(self.base,d['child']))
        with self.assertRaisesRegex(StoreError,'MIGRATION_LIVE_CONSUMER'):freeze_stages(self.operator,**d['spec'])
        self.assertEqual(self.state(d),[('personal',False)]*2)
        self.assertEqual(session.raw.execute('SELECT 1,orbita_common.workspace_id()').fetchone(),(1,None))
        with self.assertRaises(StoreError):Session(self.base,d['child'])
        self.close_all();freeze_stages(self.operator,**d['spec'])

    def test_freeze_waits_for_uncommitted_admission_then_reports_it(self):
        d=self.domain();self.close_all();raw=psycopg.connect(**self.base.connection_parameters(),autocommit=True)
        self.keep(raw);raw.execute('BEGIN');raw.execute('SELECT orbita_common.authorize_workspace(%s,%s,false)',(d['child'].workspace_id,d['child'].capability))
        started=threading.Event()
        def freeze():started.set();return freeze_stages(self.operator,**d['spec'])
        with ThreadPoolExecutor(max_workers=1) as pool:
            task=pool.submit(freeze);self.assertTrue(started.wait(2));time.sleep(.15);self.assertFalse(task.done())
            raw.execute('COMMIT')
            with self.assertRaisesRegex(StoreError,'MIGRATION_LIVE_CONSUMER'):task.result(10)
        self.assertEqual(raw.execute('SELECT 1').fetchone(),(1,))

    def test_unknown_reply_uses_durable_receipt_idempotently(self):
        d=self.ready(self.domain());first=self.publish(d)
        read=publication_receipt(self.operator,instance_id=self.base.instance_id,operation_id=d['request']['operation_id'])
        self.assertEqual(read['receipt'],first);self.assertEqual(self.publish(d),first)
        changed=dict(d['request'],manifest={})
        with self.assertRaisesRegex(StoreError,'MIGRATION_OPERATION_CHANGED'):publish_domain(self.operator,**changed)

    def test_publication_requires_freeze_and_complete_child_coverage(self):
        d=self.domain();self.close_all();d['request']['manifest']=stage_manifest(self.operator,**d['spec'])
        with self.assertRaisesRegex(StoreError,'MIGRATION_STAGE_REQUIRED'):self.publish(d)
        freeze_stages(self.operator,**d['spec'])
        wrong=dict(d['request'],children={'ws-'+str(uuid.uuid4()):d['child'].workspace_id})
        with self.assertRaisesRegex(StoreError,'MIGRATION_LOCAL_COVERAGE'):publish_domain(self.operator,**wrong)
        self.assertEqual(self.state(d),[('personal',False)]*2)

    def test_purged_tombstone_remains_inactive_and_cannot_be_reprovisioned(self):
        d=self.ready(self.domain(purged=True));self.publish(d);control=self.fresh_control(d)
        state=control.raw.execute("SELECT orbita_common.managed_binding(%s,'state')",(d['local'],)).fetchone()[0]
        self.assertTrue(state['purged']);self.assertEqual(state['purge'],d['body']['purge'])
        with self.assertRaisesRegex(psycopg.Error,'MANAGED_PURGED'):control.raw.execute('SELECT orbita_common.provision_managed(%s)',(d['local'],))
        with self.assertRaises(StoreError):Session(self.base,self.rebound(d['child']))

    def test_purged_content_is_rejected(self):
        d=self.domain(purged=True);d['store'].write_bytes('residual',b'cannot discard');self.ready(d)
        with self.assertRaisesRegex(StoreError,'MIGRATION_PURGED_CONTENT'):self.publish(d)
        self.assertEqual(self.state(d),[('personal',False)]*2)

    def test_archive_lookup_checks_original_payload_and_local_id(self):
        d=self.ready(self.domain());self.publish(d);control=self.fresh_control(d);a=d['archive']
        original=control.execute('SELECT payload FROM archives').fetchone()[0]
        lookup=lambda local:control.raw.execute('SELECT orbita_common.managed_legacy_archive(%s,%s)',(local,a['id'])).fetchone()[0]
        self.assertEqual(lookup(d['local']),dict(logicalKey='backups/'+a['id']+'.orbita',sha256=a['sha256']))
        with self.assertRaisesRegex(psycopg.Error,'MANAGED_ARCHIVE_BINDING'):lookup('ws-'+str(uuid.uuid4()))
        control.execute('UPDATE archives SET payload=?',(original+' ',))
        with self.assertRaisesRegex(psycopg.Error,'MANAGED_ARCHIVE_BINDING'):lookup(d['local'])

    def test_same_local_and_archive_ids_are_isolated_by_control(self):
        first=self.domain();second=self.domain(local=first['local'],archive_id=first['archive']['id']);self.close_all()
        self.ready(first);self.publish(first);self.ready(second);self.publish(second)
        a=self.fresh_control(first);b=self.fresh_control(second)
        b.execute('UPDATE archives SET payload=payload||\' \'' )
        params=(first['local'],first['archive']['id'])
        self.assertEqual(a.raw.execute('SELECT orbita_common.managed_legacy_archive(%s,%s)',params).fetchone()[0]['sha256'],first['archive']['sha256'])
        with self.assertRaisesRegex(psycopg.Error,'MANAGED_ARCHIVE_BINDING'):b.raw.execute('SELECT orbita_common.managed_legacy_archive(%s,%s)',params)

    def test_worker_cannot_read_control_or_private_receipts_or_archive_map(self):
        d=self.ready(self.domain());self.publish(d);control=self.fresh_control(d)
        details=control.raw.execute("SELECT orbita_common.managed_binding(%s,'worker')",(d['local'],)).fetchone()[0]
        worker=self.keep(Session(self.base,replace(d['child'],capability=details['capability'])))
        with self.assertRaisesRegex(psycopg.Error,'CONTROL_AUTHORITY_REQUIRED'):worker.raw.execute('SELECT orbita_common.managed_legacy_archive(%s,%s)',(d['local'],d['archive']['id']))
        for table in ('managed_publications','managed_legacy_archives'):
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):worker.raw.execute('SELECT * FROM orbita_private.'+table)

    def test_bad_archive_hash_rejects_without_partial_authority(self):
        d=self.domain();d['store'].write_bytes('backups/'+d['archive']['id']+'.orbita',b'different ciphertext');self.ready(d)
        with self.assertRaisesRegex(StoreError,'MIGRATION_ARCHIVE_CIPHERTEXT'):self.publish(d)
        self.assertEqual(self.state(d),[('personal',False)]*2)

    def test_archive_mapping_is_removed_only_with_its_control_row(self):
        d=self.ready(self.domain());self.publish(d);control=self.fresh_control(d)
        control.execute('DELETE FROM archives WHERE id=?',(d['archive']['id'],))
        with connect_operator(self.operator) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM orbita_private.managed_legacy_archives WHERE control_store_id=%s',(d['request']['control_store'],)).fetchone(),(0,))
            self.assertEqual(db.execute('SELECT count(*) FROM orbita_private.managed_publications WHERE operation_id=%s',(d['request']['operation_id'],)).fetchone(),(1,))

    def test_wrong_instance_rejected_before_freezing(self):
        d=self.domain();self.close_all()
        with self.assertRaisesRegex(StoreError,'MIGRATION_INSTANCE'):freeze_stages(self.operator,**dict(d['spec'],instance_id=str(uuid.uuid4())))
        self.assertEqual(self.state(d),[('personal',True)]*2)

    def test_purged_owner_erasure_does_not_prevent_tombstone_preservation(self):
        d=self.domain(purged=True)
        d['control'].execute('DELETE FROM members')
        d['control'].execute('UPDATE users SET name=NULL,salt=NULL,password=NULL,enabled=0,epoch=epoch+1')
        self.ready(d);self.publish(d);control=self.fresh_control(d)
        self.assertEqual(control.execute('SELECT enabled,password,epoch FROM users').fetchone(),(0,None,8))
        self.assertEqual(control.execute('SELECT count(*) FROM members').fetchone(),(0,))
        self.assertTrue(control.raw.execute("SELECT orbita_common.managed_binding(%s,'state')",(d['local'],)).fetchone()[0]['purged'])

    def test_unpurged_space_still_requires_original_owner_membership(self):
        d=self.domain();d['control'].execute('DELETE FROM members');self.ready(d)
        with self.assertRaisesRegex(StoreError,'MIGRATION_OWNER_IDENTITY'):self.publish(d)
        self.assertEqual(self.state(d),[('personal',False)]*2)

    def test_original_writer_control_archive_and_erased_owner_through_application(self):
        from orbita_store.legacy_plan import build_plan
        from orbita_store.legacy_import import import_bundle,verified_copy
        from orbita_store.legacy_sqlite import NativeReadHold
        app=Path(__file__).parents[2]/'app'
        native=Path(os.environ['TEMP'])/('legacy-managed-'+str(uuid.uuid4()))
        node=os.environ['ORBITA_TEST_NODE'];oracle=os.environ['ORBITA_TEST_I05_ORACLE']
        produced=subprocess.run([node,str(app/'managed-legacy-producer-fixture.mjs'),oracle,str(native)],capture_output=True,text=True,encoding='utf8',timeout=60,creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertEqual(produced.returncode,0,produced.stderr)
        original=json.loads(produced.stdout);parent=self.personal();child=self.personal();purged=self.personal()
        cfg=replace(self.base,bindings=(parent,child,purged))
        source=native/'access.sqlite';source_hash=hashlib.sha256(source.read_bytes()).hexdigest()
        with self.assertRaisesRegex(StoreError,'LEGACY_SOURCE_HASH'):
            import_access_snapshot(self.operator,source,'0'*64,Path(parent.root)/'access.pgstore',config=cfg)
        imported=import_access_snapshot(self.operator,source,source_hash,Path(parent.root)/'access.pgstore',config=cfg)
        with self.assertRaisesRegex(StoreError,'MIGRATION_ACCESS_ALREADY_PRESENT'):
            import_access_snapshot(self.operator,source,source_hash,Path(parent.root)/'access.pgstore',config=cfg)
        self.assertFalse(imported['authorityPublished']);self.assertEqual(len(imported['result']['manifest']['tables']),8)
        plan=build_plan(native/'spaces'/original['local']/'data')
        import_bundle(plan,Path(child.root)/'data',Path(child.root)/'import-stage',config=cfg)
        cipher=Path(original['archive']['archive'])
        with NativeReadHold(cipher,original['archive']['sha256']) as held,ObjectStore(self.base,child) as objects:
            key='backups/'+original['archive']['id']+'.orbita'
            copied=verified_copy(objects,key,held.file,held.identity.st_size,progress=lambda value:None)
            self.assertEqual(copied['sha256'],original['archive']['sha256']);held.verify()
        close_idle()
        spec=dict(instance_id=self.base.instance_id,control=parent.workspace_id,children={original['local']:child.workspace_id,original['purged']:purged.workspace_id})
        manifest=stage_manifest(self.operator,**spec);freeze_stages(self.operator,**spec)
        receipt=publish_domain(self.operator,**spec,operation_id=str(uuid.uuid4()),control_store=imported['storeId'],manifest=manifest)
        self.assertEqual(receipt['archiveBindings'],1)
        runtime=json.loads(Path(os.environ['ORBITA_POSTGRES_TEST_CONFIG']).read_text())
        current=self.rebound(parent)
        runtime['bindings']=[dict(root=current.root,workspaceId=current.workspace_id,capability=current.capability)]
        private=Path(os.environ['ORBITA_POSTGRES_TEST_CONFIG']).parent/('managed-legacy-fixture-'+str(uuid.uuid4())+'.json')
        private.write_text(json.dumps(runtime),encoding='utf8')
        env=dict(os.environ,ORBITA_POSTGRES_CONFIG=str(private))
        checked=subprocess.run([node,str(app/'managed-legacy-check-fixture.mjs'),str(native/'producer.json'),parent.root],env=env,capture_output=True,text=True,encoding='utf8',timeout=60,creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertEqual(checked.returncode,0,checked.stderr)
        self.assertEqual(json.loads(checked.stdout)['status'],'PASS_ORIGINAL_ACCESS_AND_ARCHIVE_MAPPING')
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),source_hash)
        self.assertEqual(hashlib.sha256(cipher.read_bytes()).hexdigest(),original['archive']['sha256'])


if __name__=='__main__':unittest.main()
