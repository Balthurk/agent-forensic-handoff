import ctypes as C
from ctypes import wintypes as W
import sys,json,hashlib,os

k=C.WinDLL('kernel32',use_last_error=True)
class Info(C.Structure):
    _fields_=[('attributes',W.DWORD),('creation',W.FILETIME),('access',W.FILETIME),('write',W.FILETIME),('volume',W.DWORD),('size_hi',W.DWORD),('size_lo',W.DWORD),('links',W.DWORD),('index_hi',W.DWORD),('index_lo',W.DWORD)]
def bind(name,result,args):
    fn=getattr(k,name);fn.restype=result;fn.argtypes=args;return fn
create=bind('CreateFileW',W.HANDLE,[W.LPCWSTR,W.DWORD,W.DWORD,C.c_void_p,W.DWORD,W.DWORD,W.HANDLE])
info=bind('GetFileInformationByHandle',W.BOOL,[W.HANDLE,C.POINTER(Info)])
mapping=bind('CreateFileMappingW',W.HANDLE,[W.HANDLE,C.c_void_p,W.DWORD,W.DWORD,W.DWORD,W.LPCWSTR])
view=bind('MapViewOfFile',C.c_void_p,[W.HANDLE,W.DWORD,W.DWORD,W.DWORD,C.c_size_t])
unmap=bind('UnmapViewOfFile',W.BOOL,[C.c_void_p])
close=bind('CloseHandle',W.BOOL,[W.HANDLE])
read=bind('ReadFile',W.BOOL,[W.HANDLE,C.c_void_p,W.DWORD,C.POINTER(W.DWORD),C.c_void_p])
def metadata(h):
    i=Info()
    if not info(h,C.byref(i)):raise C.WinError(C.get_last_error())
    return {'identity':str(i.volume)+':'+str((i.index_hi<<32)|i.index_lo),'bytes':(i.size_hi<<32)|i.size_lo,'attributes':i.attributes,'last_write':str((i.write.dwHighDateTime<<32)|i.write.dwLowDateTime)}
drive_type=bind('GetDriveTypeW',W.UINT,[W.LPCWSTR])
def observe(file):
    file=os.path.abspath(file);events=[];h=m=p=None
    if len(sys.argv)!=4:raise ValueError('Exact file, archive root and boundary ID required')
    archive=os.path.abspath(sys.argv[2]);boundary=sys.argv[3]
    if file!=os.path.join(archive,'ledger.sqlite-shm') or not boundary.startswith('shm04-'):raise ValueError('Exact scoped SHM target required')
    drive=os.path.splitdrive(file)[0]+'\\'
    if not os.path.isabs(file) or file.startswith('\\\\') or drive_type(drive)!=3:raise ValueError('Only local fixed-drive SHM is supported')
    cursor=archive
    while cursor and cursor!=os.path.dirname(cursor):
        if os.lstat(cursor).st_file_attributes&0x400:raise ValueError('Reparse ancestor rejected')
        cursor=os.path.dirname(cursor)
    try:
        h=create(file,0x80000000,0x7,None,3,0x00200000,None)
        if h==C.c_void_p(-1).value:raise C.WinError(C.get_last_error())
        events.append({'api':'CreateFileW','desired_access':'GENERIC_READ','share':'READ|WRITE|DELETE','creation':'OPEN_EXISTING','flags':'FILE_FLAG_OPEN_REPARSE_POINT','ok':True})
        before=metadata(h);events.append({'api':'GetFileInformationByHandle','when':'before',**before})
        if before['attributes']&0x400:raise ValueError('Reparse point is not an admissible observation target')
        size=before['bytes']
        if not 0<size<=16*1024*1024:raise ValueError('Bounded experiment requires nonempty file <=16MiB')
        buf=C.create_string_buffer(size);n=W.DWORD();ok=read(h,buf,size,C.byref(n),None);err=C.get_last_error() if not ok else None
        if not ok and err!=33:raise C.WinError(err)
        direct=hashlib.sha256(buf.raw[:n.value]).hexdigest() if ok else None
        events.append({'api':'ReadFile','ok':bool(ok),'error':err,'bytes':n.value,'sha256':direct})
        m=mapping(h,None,0x02,0,0,None)
        if not m:raise C.WinError(C.get_last_error())
        events.append({'api':'CreateFileMappingW','protect':'PAGE_READONLY','maximum_size':0,'file_handle':'same GENERIC_READ handle','name':None,'ok':True})
        p=view(m,0x04,0,0,size)
        if not p:raise C.WinError(C.get_last_error())
        events.append({'api':'MapViewOfFile','access':'FILE_MAP_READ','offset':0,'bytes':size,'ok':True})
        data=C.string_at(p,size);digest=hashlib.sha256(data).hexdigest();events.append({'api':'copy_from_mapped_view','bytes':len(data),'sha256':digest})
        bad=view(m,0x02,0,0,size);baderr=C.get_last_error() if not bad else None
        events.append({'api':'MapViewOfFile','role':'WRITE_ACCESS_NEGATIVE','access':'FILE_MAP_WRITE','ok':bool(bad),'error':baderr})
        if bad:unmap(bad);raise AssertionError('Read-only mapping unexpectedly admitted writable view')
        after=metadata(h);events.append({'api':'GetFileInformationByHandle','when':'after',**after});assert before==after
        if ok:assert n.value==size and direct==digest,'ReadFile and mapped bytes differ at this boundary'
        result={'file':file,'archive_root':archive,'boundary_id':boundary,'local_drive_type':3,'pid':os.getpid(),'metadata':before,'sha256':digest,'bytes_read':len(data),'readfile_ok':bool(ok),'readfile_error':err,'mapped_read_only':True,'native_calls':events}
    finally:
        if p:events.append({'api':'UnmapViewOfFile','ok':bool(unmap(p))})
        if m:events.append({'api':'CloseHandle','handle':'mapping','ok':bool(close(m))})
        if h and h!=C.c_void_p(-1).value:events.append({'api':'CloseHandle','handle':'file','ok':bool(close(h))})
    if any(e.get('ok') is not True for e in events if e['api'] in ['UnmapViewOfFile','CloseHandle']):raise ValueError('Native handle cleanup failed')
    return result
if __name__=='__main__':
    try:print(json.dumps(observe(sys.argv[1])))
    except BaseException as e:print(json.dumps({'error':type(e).__name__,'message':str(e)}));sys.exit(1)
