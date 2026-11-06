"""A retained reader must survive GC using an older activity snapshot."""
from pathlib import Path
import json
import os
import time
import unittest
import uuid

from orbita_store import StoreError
from orbita_store.admin import connect_operator, provision_workspace
from orbita_store.config import Binding, parse_config
from orbita_store.objects import ObjectStore
from orbita_store.pool import close_idle


class RetainedReaderConcurrency(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.operator = json.loads(Path(os.environ['ORBITA_INSTALLATION_TEST_OPERATOR']).read_text())
        assert cls.operator['dbname'] == 'orbita_installation'
        assert cls.operator['user'] == 'orbita_install_owner' and cls.operator['port'] != 15438
        assert cls.operator['instanceId'] != 'dc1b1f4a-a445-48a1-9b12-0679686424cf'
        cls.run_id = str(uuid.uuid4())
        cls.ids = []

    def setUp(self):
        close_idle()
        row = provision_workspace(self.operator, label='qualification:' + self.run_id + ':gc', kind='test')
        self.ids.append(row['workspaceId'])
        self.root = Path(os.environ['ORBITA_POSTGRES_TEST_ROOT']) / row['workspaceId']
        self.binding = Binding(str(self.root), row['workspaceId'], row['capability'])
        value = {k: self.operator[k] for k in ('host', 'port', 'dbname')}
        value.update(schema=1, user='orbita_runtime', password=self.operator['runtimePassword'],
                     instanceId=self.operator['instanceId'], bindings=[dict(root=str(self.root), **row)])
        self.config = parse_config(value)
        self.writer = ObjectStore(self.config, self.binding)
        self.writer.mkdir('', parents=True, exist_ok=True)
        self.content = ('retained café 😀\r\n' * 300).encode()
        self.writer.write_bytes('literal.bin', self.content)
        self.object_id = self.writer.stat('literal.bin')['objectId']
        self.others = []

    def tearDown(self):
        self.writer.raw.rollback()
        for other in self.others:
            other.close()
        self.writer.close()
        close_idle()
        self.assertFalse(self.root.exists())

    @classmethod
    def tearDownClass(cls):
        close_idle()
        target = Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS']) / ('fixtures-gc-' + cls.run_id + '.json')
        target.write_text(json.dumps(dict(workspaceIds=cls.ids, instanceId=cls.operator['instanceId'])))

    def open_reader(self):
        other = ObjectStore(self.config, self.binding, read_only=True)
        self.others.append(other)
        return other, other.open_read('literal.bin')

    def capture_activity(self):
        self.writer.raw.execute('SELECT pg_stat_clear_snapshot()')
        return {r[0] for r in self.writer.raw.execute('SELECT pid FROM pg_stat_activity')}

    def assert_exact_bytes(self, reader):
        try:
            actual = reader.read()
        except StoreError as error:
            actual = dict(error=error.code)
        self.assertEqual(actual, self.content)

    def test_new_reader_survives_collection_from_cached_activity(self):
        with self.writer.raw.transaction():
            earlier = self.capture_activity()
            other, reader = self.open_reader()
            self.assertNotIn(other.raw.info.backend_pid, earlier)
            self.writer.unlink('literal.bin')
        self.assert_exact_bytes(reader)
        self.assertEqual(self.writer.collect([self.object_id]), 0)

    def test_existing_reader_is_a_positive_control(self):
        other, reader = self.open_reader()
        with self.writer.raw.transaction():
            earlier = self.capture_activity()
            self.assertIn(other.raw.info.backend_pid, earlier)
            self.writer.unlink('literal.bin')
        self.assert_exact_bytes(reader)
        self.assertEqual(self.writer.collect([self.object_id]), 0)

    def test_disconnected_reader_is_reclaimed(self):
        other, reader = self.open_reader()
        pid = other.raw.info.backend_pid
        self.writer.unlink('literal.bin')
        self.assertEqual(self.writer.collect([self.object_id]), 0)
        other.session.close(reusable=False)
        reader.close()
        deadline = time.monotonic() + 5
        with connect_operator(self.operator) as db:
            while db.execute('SELECT 1 FROM pg_stat_activity WHERE pid=%s', (pid,)).fetchone():
                self.assertLess(time.monotonic(), deadline, 'OWNED_READER_BACKEND_NOT_CLOSED')
                time.sleep(.02)
        self.assertEqual(self.writer.collect([self.object_id]), 1)
        self.assertEqual(self.writer.collect([self.object_id]), 0)


if __name__ == '__main__':
    unittest.main()
