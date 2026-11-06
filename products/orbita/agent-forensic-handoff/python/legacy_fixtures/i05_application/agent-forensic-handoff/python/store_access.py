"""Same cross-process exclusion protocol as app/store-access.mjs.

The bridge registers independently of its parent, including after a parent crash.
"""
import atexit, os, sqlite3, uuid
from pathlib import Path

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
    root=Path(root).absolute()
    for p in (root,*root.parents):
        if p.is_symlink() or (hasattr(p,'is_junction') and p.is_junction()):raise ValueError('RECOVERY_LINK_PATH')
    root.parent.mkdir(parents=True,exist_ok=True)
    file=root.parent/('.'+root.name+'.orbita-access.sqlite'); token=str(uuid.uuid4())
    if file.is_symlink() or (file.exists() and file.stat().st_nlink!=1):raise ValueError('RECOVERY_ALIASED_GUARD')
    with sqlite3.connect(file,timeout=5) as db:
        db.execute('CREATE TABLE IF NOT EXISTS owners(token TEXT PRIMARY KEY,pid INTEGER NOT NULL,mode TEXT NOT NULL)')
        db.execute('BEGIN IMMEDIATE')
        for previous,pid in db.execute('SELECT token,pid FROM owners').fetchall():
            if not alive(pid):db.execute('DELETE FROM owners WHERE token=?',(previous,))
        if db.execute("SELECT 1 FROM owners WHERE mode='exclusive'").fetchone():raise ValueError('RECOVERY_STORE_LOCKED')
        db.execute('INSERT INTO owners VALUES(?,?,?)',(token,os.getpid(),'shared'))
    def release():
        with sqlite3.connect(file,timeout=5) as db:db.execute('DELETE FROM owners WHERE token=?',(token,))
    atexit.register(release)
