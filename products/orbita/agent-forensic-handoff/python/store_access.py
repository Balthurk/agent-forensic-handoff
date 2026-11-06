"""Same cross-process exclusion protocol as app/store-access.mjs.

The bridge registers independently of its parent, including after a parent crash.
"""
import atexit, os
from pathlib import Path
from orbita_store.config import read_config
from orbita_store.leases import StoreLease

def alive(pid):
    if os.name == 'nt':
        import ctypes
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.OpenProcess.restype=ctypes.c_void_p
        kernel.GetExitCodeProcess.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_ulong)]
        kernel.CloseHandle.argtypes=[ctypes.c_void_p]
        handle=kernel.OpenProcess(0x1000,False,pid)
        if not handle: return ctypes.get_last_error()!=87
        try:
            code=ctypes.c_ulong()
            return not kernel.GetExitCodeProcess(handle,ctypes.byref(code)) or code.value==259
        finally: kernel.CloseHandle(handle)
    try: os.kill(pid,0);return True
    except ProcessLookupError:return False
    except PermissionError:return True

def use_store(root):
    lease=StoreLease(root,config=read_config())
    atexit.register(lease.close)
    return lease
