"""Literal bytes, positioning and custody through the public import reader."""
import hashlib,io,os,tempfile,unittest
from pathlib import Path
from orbita_store import StoreError
from orbita_store.legacy_sqlite import NativeReadHold


class NativeReadHoldContract(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='orbita-native-read-')
        self.addCleanup(self.temp.cleanup)
        self.source=Path(self.temp.name)/'literal-ñ😀.bin'
        self.raw=bytes(range(256))*521+b'\x00\xff\r\n'+('café😀\r\n'*21).encode()
        self.source.write_bytes(self.raw)
        self.digest=hashlib.sha256(self.raw).hexdigest()

    def test_bytes_readall_readinto_and_64bit_positions(self):
        with NativeReadHold(self.source,self.digest) as held:
            f=held.file
            self.assertEqual(f.read(17),self.raw[:17]);self.assertEqual(f.tell(),17)
            target=bytearray(b'?'*20)
            self.assertEqual(f.readinto(memoryview(target)[3:13]),10)
            self.assertEqual(target,b'???'+self.raw[17:27]+b'?'*7)
            self.assertEqual(f.seek(-5,os.SEEK_CUR),22)
            self.assertEqual(f.read(5),self.raw[22:27])
            self.assertEqual(f.seek(2**33),2**33);self.assertEqual(f.read(1),b'')
            self.assertEqual(f.seek(-11,os.SEEK_END),len(self.raw)-11)
            self.assertEqual(f.read(),self.raw[-11:]);self.assertEqual(f.read(),b'')
            f.seek(0);self.assertEqual(f.readall(),self.raw);held.verify()
            with self.assertRaises(OverflowError):f.seek(2**63)
            with self.assertRaises(ValueError):f.seek(0,3)

    def test_independent_readers_retain_independent_positions(self):
        with NativeReadHold(self.source,self.digest) as a,NativeReadHold(self.source,self.digest) as b:
            self.assertEqual(a.file.read(47),self.raw[:47])
            self.assertEqual(b.file.read(11),self.raw[:11])
            self.assertEqual(a.file.read(9),self.raw[47:56])
            b.verify();self.assertEqual(a.file.tell(),56)
            self.assertEqual(b.file.read(),self.raw)

    def test_write_delete_and_rename_denied_until_every_hold_closes(self):
        a=NativeReadHold(self.source,self.digest);b=NativeReadHold(self.source,self.digest)
        self.addCleanup(a.close);self.addCleanup(b.close)
        for release in (lambda:None,a.close):
            release()
            with self.assertRaises(OSError) as e:
                with self.source.open('r+b') as f:f.write(b'changed')
            self.assertIsInstance(e.exception,PermissionError)
            self.assertEqual(e.exception.errno,13)
            with self.assertRaises(OSError) as e:self.source.unlink()
            self.assertEqual(e.exception.winerror,32)
            with self.assertRaises(OSError) as e:self.source.rename(self.source.with_name('moved.bin'))
            self.assertEqual(e.exception.winerror,32)
        b.verify();b.close()
        with self.source.open('r+b') as f:f.write(self.raw[:1])
        moved=self.source.with_name('after-close.bin');self.source.rename(moved)
        self.assertEqual(moved.read_bytes(),self.raw)

    def test_rejected_hash_and_budget_leave_no_source_lock(self):
        with self.assertRaisesRegex(StoreError,'LEGACY_SOURCE_HASH'):NativeReadHold(self.source,'0'*64)
        with self.assertRaisesRegex(StoreError,'LEGACY_SOURCE_BYTE_BUDGET'):NativeReadHold(self.source,max_bytes=1)
        with self.source.open('r+b') as f:f.write(self.raw[:1])
        self.assertEqual(self.source.read_bytes(),self.raw)

    def test_closed_stream_rejects_io_and_close_is_idempotent(self):
        held=NativeReadHold(self.source,self.digest);stream=held.file
        held.close();held.close();stream.close()
        for operation in (lambda:stream.read(1),lambda:stream.readinto(bytearray(1)),lambda:stream.seek(0),stream.tell):
            with self.assertRaises(ValueError):operation()
        with self.assertRaises(io.UnsupportedOperation):stream.fileno()
