"""I03: real owned link paths plus explicit unsupported-runtime simulations."""
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(os.environ.get('AFH_I03_CANDIDATE', Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(ROOT / 'agent-forensic-handoff' / 'python'))
sys.path.insert(0, str(ROOT / 'app'))
from afh_semantic import postgres_backend
import volume_store
from orbita_store.config import plain_local_path
from orbita_store import StoreError


class PathSafetyTests(unittest.TestCase):
    def setUp(self):
        self.parent = Path(os.environ.get('AFH_TEST_ROOT', tempfile.gettempdir())).resolve()
        self.root = Path(tempfile.mkdtemp(prefix='orbita-i03-path-', dir=self.parent)).resolve()
        self.links = []

    def tearDown(self):
        for link in self.links:
            if os.path.lexists(link):
                if os.name == 'nt' and link.is_junction(): os.rmdir(link)
                else: link.unlink()
        self.assertEqual(self.root.parent, self.parent)
        self.assertTrue(self.root.name.startswith('orbita-i03-path-'))
        shutil.rmtree(self.native_fixture(self.root))

    def native_fixture(self, value):
        # Independent fixture spelling: do not use the helper under test to
        # create the long paths whose inspection is being verified.
        return Path('\\\\?\\' + str(value)) if os.name == 'nt' else value

    def long_parent(self):
        parent = self.root / ('a' * 90) / ('b' * 90)
        while len(str(parent)) <= 260:
            parent = parent / ('c' * 90)
        self.assertGreater(len(str(parent)), 260)
        self.native_fixture(parent).mkdir(parents=True)
        return parent

    def readers(self):
        return (volume_store.plain, postgres_backend.plain, plain_local_path)

    def reject(self, target, code):
        for reader in self.readers():
            with self.subTest(reader=reader.__module__), self.assertRaisesRegex(StoreError if reader is plain_local_path else ValueError if reader is postgres_backend.plain else volume_store.VolumeError, code):
                reader(target)

    def link(self, target, link):
        if os.name == 'nt':
            import _winapi
            _winapi.CreateJunction(str(target), str(link))
        else: link.symlink_to(target, target_is_directory=True)
        self.links.append(link)

    def test_normal_and_missing_paths_with_spaces_do_not_create_files(self):
        target = self.root / 'root with spaces' / 'not created'
        for reader in self.readers(): self.assertEqual(reader(target), target)
        self.assertFalse(target.parent.exists())

    def test_actual_junction_or_symlink_is_rejected_with_missing_descendant(self):
        target = self.root / 'target'; target.mkdir()
        link = self.root / 'link'; self.link(target, link)
        self.reject(link / 'missing', 'LINK_PATH')

    def test_actual_broken_junction_or_symlink_is_rejected(self):
        target = self.root / 'target'; target.mkdir()
        link = self.root / 'broken'; self.link(target, link)
        moved = self.root / 'target moved'
        self.assertEqual(target.resolve().parent, self.root)
        self.assertEqual(moved.resolve().parent, self.root)
        target.rename(moved)
        self.assertFalse(link.exists())
        self.reject(link, 'LINK_PATH')
        self.reject(link / 'missing', 'LINK_PATH')

    def test_link_before_parent_traversal_is_rejected(self):
        target = self.root / 'target'; target.mkdir()
        link = self.root / 'link'; self.link(target, link)
        self.reject(link / '..' / 'new', 'LINK_PATH')

    def test_actual_hardlinks_are_rejected_without_content_change(self):
        target = self.root / 'original'; target.write_bytes(b'owned fixture\x00\xff')
        link = self.root / 'hardlink'; os.link(target, link)
        self.reject(link, 'HARDLINK'); self.reject(target, 'HARDLINK')
        self.assertEqual(target.read_bytes(), b'owned fixture\x00\xff')

    def test_long_regular_path_is_inspected_without_changing_logical_spelling(self):
        target = self.long_parent() / 'literal.bin'
        self.native_fixture(target).write_bytes(b'long native evidence\x00\xff')
        for reader in self.readers(): self.assertEqual(reader(target), target)
        self.assertEqual(self.native_fixture(target).read_bytes(), b'long native evidence\x00\xff')

    def test_long_hardlinked_entry_is_not_mistaken_for_a_missing_path(self):
        target = self.root / 'unique'; target.write_bytes(b'keep exact bytes')
        link = self.long_parent() / 'hardlink'
        os.link(self.native_fixture(target), self.native_fixture(link))
        self.reject(link, 'HARDLINK')
        self.assertEqual(target.read_bytes(), b'keep exact bytes')

    def test_long_junction_is_rejected_even_with_a_missing_descendant(self):
        target = self.root / 'target'; target.mkdir()
        link = self.long_parent() / 'junction'
        # CreateJunction builds the NT substitute target itself. Its short
        # absolute target must not be given another extended namespace.
        self.link(target, self.native_fixture(link))
        self.assertTrue(os.path.samefile(self.native_fixture(link), target))
        self.reject(link / 'missing', 'LINK_PATH')

    def test_old_python_refused_before_volume_or_semantic_store_creation(self):
        volume = self.root / 'volume root'; semantic = self.root / 'records.sqlite3'
        with patch.object(sys, 'version_info', (3, 11, 99)):
            with self.assertRaisesRegex(volume_store.VolumeError, 'PYTHON_3_12_REQUIRED'): volume_store.Store(volume).close()
            with self.assertRaisesRegex(ValueError, 'PYTHON_3_12_REQUIRED'): postgres_backend.connect(semantic).close()
            with self.assertRaisesRegex(StoreError, 'PYTHON_3_12_REQUIRED'): plain_local_path(semantic)
        self.assertFalse(volume.exists()); self.assertFalse(semantic.exists())

    def test_missing_junction_capability_fails_explicitly_before_creation(self):
        target = self.root / 'never created'
        with patch.object(Path, 'is_junction', None):
            self.reject(target, 'PYTHON_PATH_CAPABILITY_REQUIRED')
        self.assertFalse(target.exists())

    def test_permission_errors_are_not_treated_as_missing_paths(self):
        real = Path.lstat; target = self.root / 'denied'
        def denied(item, *args, **kwargs):
            if item == target: raise PermissionError('owned simulated denial')
            return real(item, *args, **kwargs)
        with patch.object(Path, 'lstat', denied): self.reject(target, 'PATH_INSPECTION_FAILED')

    def test_dangling_symbolic_link_metadata_is_rejected(self):
        real = Path.lstat; target = self.root / 'synthetic dangling link'
        def metadata(item, *args, **kwargs):
            if item == target: return types.SimpleNamespace(st_mode=stat.S_IFLNK, st_nlink=1, st_file_attributes=0)
            return real(item, *args, **kwargs)
        with patch.object(Path, 'lstat', metadata): self.reject(target, 'LINK_PATH')

    def test_other_windows_reparse_metadata_is_rejected(self):
        if os.name != 'nt':
            self.assertNotEqual(os.name, 'nt'); return
        real = Path.lstat; target = self.root / 'synthetic other reparse'
        def metadata(item, *args, **kwargs):
            if item == target: return types.SimpleNamespace(st_mode=stat.S_IFDIR, st_nlink=1, st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT)
            return real(item, *args, **kwargs)
        with patch.object(Path, 'lstat', metadata): self.reject(target, 'LINK_PATH')

    def test_missing_windows_attributes_fail_closed(self):
        if os.name != 'nt':
            self.assertNotEqual(os.name, 'nt'); return
        real = Path.lstat; target = self.root / 'synthetic missing attributes'
        def metadata(item, *args, **kwargs):
            if item == target: return types.SimpleNamespace(st_mode=stat.S_IFDIR, st_nlink=1)
            return real(item, *args, **kwargs)
        with patch.object(Path, 'lstat', metadata): self.reject(target, 'PYTHON_REPARSE_CAPABILITY_REQUIRED')


if __name__ == '__main__': unittest.main(verbosity=2)
