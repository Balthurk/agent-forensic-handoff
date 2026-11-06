"""Read-only Win32 stream retaining its no-write/no-delete sharing handle.

Long-lived custody must not consume one limited C-runtime descriptor per file.
A temporary duplicate is used only for Python's exact fstat representation.
The original kernel handle remains open throughout; it is never reopened by path.
"""
import ctypes
from functools import lru_cache
import io
import operator
import os
import threading
from .config import require


@lru_cache(maxsize=1)
def _api():
    from ctypes import wintypes as w
    api=ctypes.WinDLL('kernel32',use_last_error=True)
    api.CreateFileW.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD,ctypes.c_void_p,w.DWORD,w.DWORD,w.HANDLE]
    api.CreateFileW.restype=w.HANDLE
    api.CloseHandle.argtypes=[w.HANDLE];api.CloseHandle.restype=w.BOOL
    api.GetCurrentProcess.argtypes=[];api.GetCurrentProcess.restype=w.HANDLE
    api.DuplicateHandle.argtypes=[w.HANDLE,w.HANDLE,w.HANDLE,ctypes.POINTER(w.HANDLE),w.DWORD,w.BOOL,w.DWORD]
    api.DuplicateHandle.restype=w.BOOL
    api.ReadFile.argtypes=[w.HANDLE,ctypes.c_void_p,w.DWORD,ctypes.POINTER(w.DWORD),ctypes.c_void_p]
    api.ReadFile.restype=w.BOOL
    api.SetFilePointerEx.argtypes=[w.HANDLE,ctypes.c_longlong,ctypes.POINTER(ctypes.c_longlong),w.DWORD]
    api.SetFilePointerEx.restype=w.BOOL
    return api


class HeldNativeReader(io.RawIOBase):
    """Synchronous binary reads and 64-bit seeks on the exact held file."""
    def __init__(self,path):
        super().__init__()
        self._lock=threading.RLock();self._handle=None;self._api=_api()
        self.name=str(path);self.mode='rb'
        handle=self._api.CreateFileW(self.name,0x80000000,1,None,3,0x08000000,None)
        require(handle!=ctypes.c_void_p(-1).value,'LEGACY_SOURCE_BUSY_OR_UNAVAILABLE')
        self._handle=handle
        try:self.identity=self._stat()
        except BaseException:self.close();raise

    def _stat(self):
        import msvcrt
        from ctypes import wintypes
        duplicate=wintypes.HANDLE();process=self._api.GetCurrentProcess()
        if not self._api.DuplicateHandle(process,self._handle,process,ctypes.byref(duplicate),0,False,2):
            raise ctypes.WinError(ctypes.get_last_error())
        try:fd=msvcrt.open_osfhandle(duplicate.value,os.O_RDONLY|os.O_BINARY)
        except BaseException:self._api.CloseHandle(duplicate);raise
        try:return os.fstat(fd)
        finally:os.close(fd)

    def _check_open(self):
        if self.closed or self._handle is None:raise ValueError('I/O operation on closed file')

    def readable(self):
        with self._lock:self._check_open();return True

    def seekable(self):
        with self._lock:self._check_open();return True

    def read(self,size=-1):
        with self._lock:self._check_open();return super().read(size)

    def readall(self):
        with self._lock:self._check_open();return super().readall()

    def readinto(self,buffer):
        with self._lock:
            self._check_open()
            view=memoryview(buffer).cast('B');count=min(view.nbytes,0x7fffffff)
            if not count:return 0
            target=(ctypes.c_char*count).from_buffer(view);read=ctypes.c_ulong()
            if not self._api.ReadFile(self._handle,target,count,ctypes.byref(read),None):
                code=ctypes.get_last_error()
                if code==38:return 0  # ERROR_HANDLE_EOF
                raise ctypes.WinError(code)
            return read.value

    def seek(self,offset,whence=os.SEEK_SET):
        with self._lock:
            self._check_open();offset=operator.index(offset);whence=operator.index(whence)
            if whence not in (os.SEEK_SET,os.SEEK_CUR,os.SEEK_END):raise ValueError('invalid whence')
            if not -(2**63)<=offset<2**63:raise OverflowError('seek offset outside signed 64-bit range')
            position=ctypes.c_longlong()
            if not self._api.SetFilePointerEx(self._handle,offset,ctypes.byref(position),whence):
                raise ctypes.WinError(ctypes.get_last_error())
            return position.value

    def tell(self):return self.seek(0,os.SEEK_CUR)

    def close(self):
        with self._lock:
            if self.closed:return
            handle=self._handle;self._handle=None
            try:
                if handle is not None and not self._api.CloseHandle(handle):raise ctypes.WinError(ctypes.get_last_error())
            finally:super().close()
