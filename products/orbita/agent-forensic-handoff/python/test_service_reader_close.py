"""Deterministic server-exit lag, foreign-client and deadline regressions."""
import datetime
import time
import unittest
from unittest.mock import patch

from orbita_store import StoreError
from orbita_store.service_backup import await_catalog_reader_closed


IDENTITY=(2718,datetime.datetime(2026,11,7,tzinfo=datetime.timezone.utc))


class Activity:
    def __init__(self, snapshots):
        self.snapshots=iter(snapshots);self.rows=None;self.settings=[];self.clears=0

    def execute(self, query, parameters=None):
        if query=='SHOW statement_timeout':self.rows=[('10min',)]
        elif query.startswith('SELECT set_config'):
            self.settings.append(parameters[0]);self.rows=[]
        elif query=='SELECT pg_stat_clear_snapshot()':self.clears+=1;self.rows=[]
        elif query.startswith('SELECT pid,backend_start FROM pg_stat_activity'):
            self.rows=next(self.snapshots)
        else:raise AssertionError(query)
        return self

    def fetchone(self):return self.rows[0]
    def fetchall(self):return self.rows


class ReaderClosureTests(unittest.TestCase):
    def test_closed_python_reader_must_disappear_on_server(self):
        db=Activity([[IDENTITY],[IDENTITY],[]])
        with patch('orbita_store.service_backup.time.sleep') as sleep:
            await_catalog_reader_closed(db,IDENTITY,deadline=time.monotonic()+30)
        self.assertEqual(db.clears,3);self.assertEqual(sleep.call_count,2)
        self.assertEqual(db.settings[-1],'10min')
        self.assertTrue(all(0<int(value[:-2])<=5000 for value in db.settings[:-1]))

    def test_already_gone_needs_no_wait(self):
        db=Activity([[]])
        with patch('orbita_store.service_backup.time.sleep') as sleep:
            await_catalog_reader_closed(db,IDENTITY,deadline=time.monotonic()+30)
        sleep.assert_not_called();self.assertEqual(db.settings[-1],'10min')

    def test_unrelated_client_is_never_waited_out(self):
        db=Activity([[(2719,IDENTITY[1])],[]])
        with patch('orbita_store.service_backup.time.sleep') as sleep,self.assertRaisesRegex(StoreError,'SERVICE_CLIENTS_ACTIVE'):
            await_catalog_reader_closed(db,IDENTITY,deadline=time.monotonic()+30)
        sleep.assert_not_called();self.assertEqual(db.clears,1)

    def test_foreign_client_alongside_reader_is_rejected(self):
        db=Activity([[IDENTITY,(2719,IDENTITY[1])],[]])
        with self.assertRaisesRegex(StoreError,'SERVICE_CLIENTS_ACTIVE'):
            await_catalog_reader_closed(db,IDENTITY,deadline=time.monotonic()+30)
        self.assertEqual(db.clears,1)

    def test_reused_pid_is_not_owned(self):
        db=Activity([[(IDENTITY[0],IDENTITY[1]+datetime.timedelta(seconds=1))]])
        with self.assertRaisesRegex(StoreError,'SERVICE_CLIENTS_ACTIVE'):
            await_catalog_reader_closed(db,IDENTITY,deadline=time.monotonic()+30)

    def test_operation_deadline_is_not_extended(self):
        db=Activity([[IDENTITY]])
        with patch('orbita_store.service_backup.time.monotonic',side_effect=[100,100,100,101,101]),patch('orbita_store.service_backup.time.sleep') as sleep,self.assertRaisesRegex(StoreError,'SERVICE_READER_CLOSE_DEADLINE'):
            await_catalog_reader_closed(db,IDENTITY,deadline=100.5)
        self.assertEqual(db.settings,['500ms']);self.assertEqual(db.clears,1)
        sleep.assert_called_once_with(0)

    def test_reader_close_wait_has_its_own_five_second_ceiling(self):
        db=Activity([[IDENTITY]])
        with patch('orbita_store.service_backup.time.monotonic',side_effect=[100,100,105]),self.assertRaisesRegex(StoreError,'SERVICE_READER_CLOSE_DEADLINE'):
            await_catalog_reader_closed(db,IDENTITY,deadline=1000)
        self.assertEqual(db.settings,['5000ms'])

    def test_deadline_precedes_any_activity_read(self):
        db=Activity([])
        with self.assertRaisesRegex(StoreError,'SERVICE_READER_CLOSE_DEADLINE'):
            await_catalog_reader_closed(db,IDENTITY,deadline=time.monotonic()-1)
        self.assertEqual(db.clears,0);self.assertEqual(db.settings,[])

    def test_query_failure_is_not_converted_to_success(self):
        db=Activity([])
        with patch.object(db,'execute',side_effect=RuntimeError('transport lost')),self.assertRaisesRegex(RuntimeError,'transport lost'):
            await_catalog_reader_closed(db,IDENTITY,deadline=time.monotonic()+30)


if __name__=='__main__':unittest.main()
