"""Real backend-bound quiescence, hierarchy, ownership and crash recovery."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
import unittest
import psycopg
import test_common_postgres_catalog as fixture
from orbita_store import StoreError
from orbita_store.admin import connect_operator
from orbita_store.leases import StoreLease
from orbita_store.session import Session

class CommonLeases(unittest.TestCase):
    setUpClass=classmethod(fixture.CommonCatalogue.setUpClass.__func__)
    tearDownClass=classmethod(fixture.CommonCatalogue.tearDownClass.__func__)
    setUp=fixture.CommonCatalogue.setUp
    tearDown=fixture.CommonCatalogue.tearDown

    def lease(self,key='',**kwargs):
        value=StoreLease(Path(self.binding.root)/key,config=self.config,**kwargs)
        self.connections.append(value);return value

    def test_multiple_shared_owners_block_exclusive_until_both_close(self):
        a=self.lease('data');b=self.lease('data')
        with self.assertRaisesRegex(StoreError,'RECOVERY_STORE_BUSY'):self.lease('data',mode='exclusive')
        a.close()
        with self.assertRaisesRegex(StoreError,'RECOVERY_STORE_BUSY'):self.lease('data',mode='exclusive')
        b.close();self.lease('data',mode='exclusive')

    def test_overlapping_ancestors_and_descendants_conflict_but_siblings_do_not(self):
        a=self.lease('data/cases',mode='exclusive')
        for key in ('','data','data/cases','data/cases/one'):
            with self.assertRaisesRegex(StoreError,'RECOVERY_STORE_LOCKED'):self.lease(key)
        self.lease('data/cases-other',mode='exclusive').close()
        self.lease('other',mode='exclusive').close();a.close()
        parent=self.lease('data')
        with self.assertRaisesRegex(StoreError,'RECOVERY_STORE_BUSY'):self.lease('data/cases',mode='exclusive')
        parent.close()

    def test_upgrade_is_atomic_and_retains_shared_owner_after_exclusive_release(self):
        shared=self.lease('data');other=self.lease('data')
        with self.assertRaisesRegex(StoreError,'RECOVERY_STORE_BUSY'):self.lease('data',mode='exclusive',own_shared=shared)
        other.close();exclusive=self.lease('data',mode='exclusive',own_shared=shared)
        self.assertIs(exclusive.session,shared.session)
        with self.assertRaisesRegex(StoreError,'RECOVERY_STORE_LOCKED'):self.lease('data')
        exclusive.close()
        with self.assertRaisesRegex(StoreError,'RECOVERY_STORE_BUSY'):self.lease('data',mode='exclusive')
        shared.close();self.lease('data',mode='exclusive')

    def test_release_and_upgrade_require_exact_server_identity_even_with_known_token(self):
        shared=self.lease('data')
        with Session(self.config,self.binding) as other:
            self.assertFalse(other.raw.execute('SELECT orbita_common.release_store_lease(%s)',(shared.token,)).fetchone()[0])
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                other.raw.execute("SELECT orbita_common.acquire_store_lease('data','exclusive',%s)",(shared.token,))
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                other.raw.execute('DELETE FROM orbita_private.store_leases')
        with self.assertRaisesRegex(StoreError,'LEASE_OWNERSHIP'):self.lease('other',mode='exclusive',own_shared=shared)
        with self.assertRaisesRegex(StoreError,'RECOVERY_STORE_BUSY'):self.lease('data',mode='exclusive')

    def test_only_dead_backend_is_reclaimed_without_lease_expiry(self):
        old=self.lease('data',mode='exclusive');identity=old.session.raw.execute('SELECT pg_backend_pid(),backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()').fetchone()
        with connect_operator(self.operator) as operator:
            row=operator.execute('SELECT pid,backend_start FROM orbita_private.store_leases WHERE id=%s',(old.token,)).fetchone()
            self.assertEqual(row,identity)
        with self.assertRaisesRegex(StoreError,'RECOVERY_STORE_LOCKED'):self.lease('data')
        old.session.close(reusable=False);old.closed=True
        self.lease('data',mode='exclusive')
        with connect_operator(self.operator) as operator:
            self.assertEqual(operator.execute('SELECT count(*) FROM orbita_private.store_leases WHERE id=%s',(old.token,)).fetchone(),(0,))

    def test_racing_exclusive_requests_have_exactly_one_winner(self):
        barrier=Barrier(3)
        def compete():
            barrier.wait(timeout=5)
            try:return StoreLease(Path(self.binding.root)/'data',config=self.config,mode='exclusive')
            except StoreError as error:return str(error)
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures=[executor.submit(compete) for _ in range(2)];barrier.wait(timeout=5)
            results=[future.result(timeout=10) for future in futures]
        winners=[r for r in results if isinstance(r,StoreLease)];self.connections.extend(winners)
        self.assertEqual(len(winners),1);self.assertEqual([r for r in results if isinstance(r,str)],['RECOVERY_STORE_BUSY'])

    def test_runtime_arguments_and_stale_snapshot_cannot_bypass_lease_protocol(self):
        with Session(self.config,self.binding) as owner:
            for root,mode in [('../escape','shared'),('/absolute','shared'),('data/','shared'),('data','invalid')]:
                with self.assertRaises(psycopg.errors.InvalidParameterValue):owner.raw.execute('SELECT orbita_common.acquire_store_lease(%s,%s)',(root,mode))
            owner.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ')
            try:
                with self.assertRaises(psycopg.errors.ActiveSqlTransaction):owner.raw.execute("SELECT orbita_common.acquire_store_lease('data','shared')")
            finally:owner.raw.rollback()
        self.lease('data',mode='exclusive')
