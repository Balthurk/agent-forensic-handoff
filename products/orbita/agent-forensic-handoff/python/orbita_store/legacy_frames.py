"""Bounded v1 extraction after authentication, into an owned private boundary.

Only current user, SYSTEM and local administrators receive inherited access.
Cleanup enumerates owned files and directories, checks their identities, and
never recursively deletes an unknown path. This is not operational storage.
"""
from pathlib import Path
import hashlib,json,os,re,stat,struct,subprocess,time,unicodedata,uuid
from afh_semantic.path_safety import native_path
from .config import plain_local_path,require
from .objects import BLOCK


def safe_member(name):
    require(isinstance(name,str) and 0<len(name.encode('utf8'))<=2048 and name==unicodedata.normalize('NFC',name) and '\\' not in name,'LEGACY_FRAME_PATH')
    for piece in name.split('/'):
        require(piece not in ('','.','..') and not re.search(r'[\x00-\x1f\x7f<>:"|?*]|[. ]$',piece) and not re.match(r'^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)',piece,re.I),'LEGACY_FRAME_PATH')
    return name


class PrivateStage:
    def __init__(self,parent,operation_id):
        require(os.name=='nt','LEGACY_NATIVE_PLATFORM_UNQUALIFIED')
        require(str(uuid.UUID(operation_id))==operation_id,'LEGACY_OPERATION_ID')
        require(Path(parent).is_absolute(),'LEGACY_PRIVATE_PARENT')
        self.parent=plain_local_path(parent);require(self.parent.is_dir(),'LEGACY_PRIVATE_PARENT')
        self.root=self.parent/('orbita-v1-'+operation_id);self.owned=[];self.closed=False
        native_path(self.root).mkdir();self.record(self.root,'directory')
        # The directory is still empty. Protect and verify its DACL before any
        # decrypted name or byte is created. No credentials cross argv/env.
        shell=Path(os.environ['SystemRoot'])/'System32/WindowsPowerShell/v1.0/powershell.exe'
        env={k:v for k,v in os.environ.items() if k.lower() in ('systemroot','windir','comspec','path','pathext','temp','tmp','lang','lc_all','tz')}
        child=None
        try:
            child=subprocess.Popen([str(shell),'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',str(Path(__file__).with_suffix('.ps1').with_name('legacy_stage.ps1')),'-Stage',str(self.root)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,creationflags=subprocess.CREATE_NO_WINDOW)
            stdout,stderr=child.communicate(timeout=20)
            require(child.returncode==0 and not stderr and json.loads(stdout)==dict(status='PROTECTED_EMPTY_STAGE',principals=3),'LEGACY_PRIVATE_ACL')
        except BaseException:
            if child is not None and child.poll() is None:child.kill();child.wait(5)
            self.cleanup();raise
        finally:
            if child is not None:
                if child.poll() is None:child.kill();child.wait(5)
                for pipe in (child.stdout,child.stderr):
                    if pipe is not None:pipe.close()
        self.data=self.root/'data';native_path(self.data).mkdir();self.record(self.data,'directory')

    def record(self,path,kind):
        actual=native_path(path).lstat();self.owned.append((Path(path),kind,actual.st_dev,actual.st_ino))

    def path(self,name):
        safe_member(name);result=self.data.joinpath(*name.split('/'))
        require(result.is_relative_to(self.data) and result!=self.data,'LEGACY_STAGE_SCOPE')
        plain_local_path(result);return native_path(result)

    def cleanup(self):
        if self.closed:return
        # Verify the whole enumerated set before the first deletion. Unknown
        # children make rmdir fail; they are never swept up recursively.
        for path,kind,device,inode in self.owned:
            require(path==self.root or path.is_relative_to(self.root),'LEGACY_STAGE_CLEANUP_SCOPE')
            plain_local_path(path);actual=native_path(path).lstat()
            require((actual.st_dev,actual.st_ino)==(device,inode) and not actual.st_file_attributes&stat.FILE_ATTRIBUTE_REPARSE_POINT,'LEGACY_STAGE_CLEANUP_IDENTITY')
            require(stat.S_ISDIR(actual.st_mode) if kind=='directory' else stat.S_ISREG(actual.st_mode) and actual.st_nlink==1,'LEGACY_STAGE_CLEANUP_TYPE')
        for path,kind,device,inode in reversed(self.owned):
            if kind=='directory':native_path(path).rmdir()
            else:native_path(path).unlink()
        self.closed=True

    def __enter__(self):return self
    def __exit__(self,kind,error,traceback):
        try:self.cleanup()
        except BaseException as cleanup_error:
            if error is None:raise
            error.add_note('Private stage cleanup failed; preserve the enumerated boundary for inspection: '+type(cleanup_error).__name__)


def extract_authenticated(reader,stage,*,expected_sha256,max_files=50000,max_bytes=50*1024**3,deadline):
    """Caller retains the immutable, fully authenticated PG payload pin."""
    require(type(max_files) is int and 1<=max_files<=50000 and type(max_bytes) is int and 1<=max_bytes<=50*1024**3,'LEGACY_FRAME_LIMITS')
    require(reader.tell()==0 and reader.item['sha256']==expected_sha256,'LEGACY_PAYLOAD_IDENTITY')
    offset=0;size=reader.item['size'];seen={};tree=hashlib.sha256();payload=hashlib.sha256();files=total=entries=0;end=None;directories=[]
    def check():require(time.monotonic()<deadline,'LEGACY_RESTORE_DEADLINE')
    def read(count):
        nonlocal offset
        check();require(type(count) is int and 0<=count<=BLOCK and offset+count<=size,'LEGACY_FRAME_TRUNCATED')
        raw=reader.read(count);require(len(raw)==count,'LEGACY_FRAME_TRUNCATED');offset+=count;payload.update(raw);return raw
    def pairs(values):
        result={}
        for key,value in values:require(key not in result,'LEGACY_FRAME_DUPLICATE_FIELD');result[key]=value
        return result
    while offset<size:
        prefix=read(4);length=struct.unpack('>I',prefix)[0];require(0<length<=8192,'LEGACY_FRAME_BUDGET');raw=read(length)
        value=json.loads(raw.decode('utf8'),object_pairs_hook=pairs,parse_constant=lambda x:(_ for _ in ()).throw(ValueError('nonfinite')))
        require(isinstance(value,dict) and json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode('utf8')==raw,'LEGACY_FRAME_CANONICAL')
        if value.get('type')=='end':end=value;break
        kind=value.get('type');require(kind in ('file','dir'),'LEGACY_FRAME_TYPE')
        require(list(value)==(['type','path'] if kind=='dir' else ['type','path','size','sha256']),'LEGACY_FRAME_FIELDS')
        name=safe_member(value['path']);folded=name.casefold();require(folded not in seen,'LEGACY_FRAME_ALIAS')
        parts=name.split('/')
        for i in range(1,len(parts)):
            parent='/'.join(parts[:i]);require(seen.get(parent.casefold())==('dir',parent),'LEGACY_FRAME_PARENT')
        seen[folded]=(kind,name);tree.update(prefix+raw);entries+=1;require(entries<=max_files*4,'LEGACY_FRAME_QUOTA')
        target=stage.path(name)
        if kind=='dir':target.mkdir();stage.record(stage.data/name,'directory');directories.append(name);continue
        count=value['size'];digest=value['sha256']
        require(type(count) is int and 0<=count<=2**53-1 and isinstance(digest,str) and re.fullmatch('[a-f0-9]{64}',digest),'LEGACY_FRAME_FILE_FIELDS')
        files+=1;total+=count;require(files<=max_files and total<=max_bytes,'LEGACY_FRAME_QUOTA')
        with target.open('xb') as output:
            stage.record(stage.data/name,'file');actual=hashlib.sha256();remaining=count
            while remaining:
                block=read(min(BLOCK,remaining));require(output.write(block)==len(block),'LEGACY_FRAME_SHORT_WRITE');actual.update(block);remaining-=len(block)
            output.flush();os.fsync(output.fileno())
        require(actual.hexdigest()==digest,'LEGACY_FRAME_MEMBER_HASH')
    require(isinstance(end,dict) and end.get('schema')=='orbita-memory-1' and offset==size,'LEGACY_FRAME_END')
    require(list(end)==['type','schema','id','createdAt','sourceRoot','files','bytes','entries','treeHash','validation'],'LEGACY_FRAME_END_FIELDS')
    require(str(uuid.UUID(end['id']))==end['id'] and isinstance(end['createdAt'],str) and isinstance(end['sourceRoot'],str) and Path(end['sourceRoot']).is_absolute(),'LEGACY_FRAME_END_IDENTITY')
    require(type(end['files']) is int and type(end['bytes']) is int and type(end['entries']) is int and (files,total,entries,tree.hexdigest())==(end['files'],end['bytes'],end['entries'],end['treeHash']),'LEGACY_FRAME_MANIFEST')
    require(payload.hexdigest()==expected_sha256,'LEGACY_PAYLOAD_HASH');check()
    return dict(end=end,directories=directories,files=files,bytes=total,entries=entries,payloadSha256=payload.hexdigest())
