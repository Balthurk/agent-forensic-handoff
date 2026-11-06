"""Explicit v1 conversion; authentication, private extraction, paused publish.

Normal v2 restore never falls back here. A failed attempt keeps its enumerated
PG import staging for inspection. Reuse is explicit; unknown commit outcomes
are inspected through private control state instead of replaying the write.
"""
from pathlib import Path
import argparse,datetime,hashlib,json,os,re,subprocess,sys,time,uuid
from . import StoreError
from .config import binding_for,plain_local_path,read_config,require
from .legacy_cipher import authenticate_archive
from .legacy_frames import PrivateStage,extract_authenticated
from .legacy_import import import_bundle,serialize_plan
from .legacy_plan import build_plan
from .legacy_verify import verify_import
from .manifests import stable
from .objects import ObjectStore
from .ownership import observe_owner
from .pool import close_idle


def application_validation(root,*,config,node,deadline):
    """Fresh application and bridge; private binding travels through stdin."""
    binding,key=binding_for(root,config)
    value=dict(schema=1,host=config.host,port=config.port,dbname=config.dbname,user=config.user,password=config.password,instanceId=config.instance_id,
               bindings=[dict(root=binding.root,workspaceId=binding.workspace_id,capability=binding.capability)])
    body=stable(dict(root=str(root),config=value,python=sys.executable));require(len(body)<=1024**2,'LEGACY_APPLICATION_INPUT_BUDGET')
    owner=str(uuid.uuid4());env={k:v for k,v in os.environ.items() if k.lower() in ('systemroot','windir','comspec','path','pathext','temp','tmp','lang','lc_all','tz')}
    env['ORBITA_POSTGRES_OWNER_ID']=owner
    script=Path(__file__).resolve().parents[3]/'app/legacy-restore-validate.mjs'
    remaining=deadline-time.monotonic();require(remaining>0,'LEGACY_RESTORE_DEADLINE')
    child=subprocess.Popen([str(node),str(script)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        stdout,stderr=child.communicate(body,timeout=min(600,remaining))
        require(child.returncode==0 and not stderr and len(stdout)<=65536,'LEGACY_APPLICATION_VALIDATION')
        result=json.loads(stdout);require(result['status']=='PASS_FRESH_APPLICATION_VALIDATION' and result['closed'] is True,'LEGACY_APPLICATION_VALIDATION')
        return result['validation']
    finally:
        if child.poll() is None:child.kill();child.wait(5)
        for pipe in (child.stdin,child.stdout,child.stderr):
            if pipe is not None:pipe.close()
        until=time.monotonic()+5
        while True:
            closure=observe_owner(config,owner)
            if closure['backends']==0 or time.monotonic()>=until:break
            time.sleep(.02)
        require(closure['backends']==0,'LEGACY_APPLICATION_CONSUMERS_NOT_CLOSED')


def inspect_restore(destination,operation_id,archive_sha256,*,config):
    """Read-only resolution of publication, including a lost commit reply."""
    require(str(uuid.UUID(operation_id))==operation_id,'LEGACY_OPERATION_ID')
    require(isinstance(archive_sha256,str) and re.fullmatch('[a-f0-9]{64}',archive_sha256),'LEGACY_EXPECTED_HASH_REQUIRED')
    binding,key=binding_for(destination,config)
    with ObjectStore(config,binding,read_only=True) as files:
        state=files.raw.execute('SELECT orbita_common.restore_state(%s)',(key,)).fetchone()[0]
        exists=files.exists(key)
        if state is None:
            require(not exists,'LEGACY_RESTORE_DESTINATION_CONFLICT')
            return dict(status='NOT_PUBLISHED',operationId=operation_id,destination=str(destination))
        require(state.get('id')==operation_id and state.get('archiveSha256')==archive_sha256 and state.get('sourceFormat')=='orbita-memory-1','LEGACY_RESTORE_OPERATION_CONFLICT')
        require(exists,'LEGACY_RESTORE_CONTROL_WITHOUT_CONTENT')
        receipt_key=key+'/.orbita-legacy/receipt.json';require(files.stat(receipt_key)['size']<=64*1024**2,'LEGACY_RESTORE_RECEIPT_BUDGET')
        raw=files.read_bytes(receipt_key);receipt=json.loads(raw)
        require(receipt['planSha256']==state['planSha256'] and receipt['workspaceId']==binding.workspace_id and all(state.get(k)==v for k,v in receipt['restoreContext'].items()),'LEGACY_RESTORE_RECEIPT_BINDING')
        return dict(status='PUBLISHED_PAUSED' if state['automaticWork'] is False and state['externalAccess'] is False else 'PUBLISHED_EXPLICITLY_ACTIVATED',operationId=operation_id,destination=str(destination),state=state,receiptSha256=hashlib.sha256(raw).hexdigest())


def restore_legacy(archive,archive_sha256,destination,stage,*,config,node,password,private_parent,operation_id,storage='native',max_files=50000,max_bytes=50*1024**3,max_seconds=21600,limits=None,vector_extension=None,progress=lambda value:None):
    require(str(uuid.UUID(operation_id))==operation_id,'LEGACY_OPERATION_ID')
    require(type(max_seconds) in (int,float) and 1<=max_seconds<=21600,'LEGACY_RESTORE_DEADLINE_BUDGET')
    require(type(max_files) is int and 1<=max_files<=50000 and type(max_bytes) is int and 1<=max_bytes<=50*1024**3,'LEGACY_FRAME_LIMITS')
    binding,key=binding_for(destination,config);other,stage_key=binding_for(stage,config)
    require(binding==other and key and stage_key and key!=stage_key and not key.startswith(stage_key+'/') and not stage_key.startswith(key+'/'),'LEGACY_RESTORE_STAGE_SCOPE')
    require(Path(node).is_absolute() and plain_local_path(node).is_file(),'LEGACY_CIPHER_NODE')
    deadline=time.monotonic()+max_seconds;authenticated=None;readback=None;application=None
    payload=Path(stage)/'cipher/payload';import_stage=Path(stage)/'import'
    def check():require(time.monotonic()<deadline,'LEGACY_RESTORE_DEADLINE')
    with ObjectStore(config,binding) as files:
        require(not files.exists(key),'LEGACY_DESTINATION_EXISTS')
        require(not files.exists(stage_key),'LEGACY_RESTORE_STAGE_EXISTS')
        files.mkdir(stage_key,parents=True)
        files.write_bytes(stage_key+'/operation.json',stable(dict(schema='orbita-v1-operation-1',id=operation_id,archiveSha256=archive_sha256,destination=key,stage=stage_key)),exclusive=True)
    try:
        authenticated=authenticate_archive(archive,archive_sha256,payload,config=config,node=node,password=password,storage=storage,max_archive_bytes=min(100*1024**3,max_bytes+max_files*32768),max_seconds=deadline-time.monotonic())
        progress(dict(event='archive-authenticated',operationId=operation_id,archiveSha256=archive_sha256));check()
        with PrivateStage(private_parent,operation_id) as native:
            with ObjectStore(config,binding,read_only=True) as files,files.open_read(stage_key+'/cipher/payload') as reader:
                require((reader.item['objectId'],reader.item['revision'])==(authenticated['payload']['objectId'],authenticated['payload']['revision']),'LEGACY_PAYLOAD_IDENTITY')
                extracted=extract_authenticated(reader,native,expected_sha256=authenticated['payload']['sha256'],max_files=max_files,max_bytes=max_bytes,deadline=deadline)
            end=extracted['end'];old=Path(end['sourceRoot']);new=Path(destination)
            require(old!=new and not old.is_relative_to(new) and not new.is_relative_to(old),'LEGACY_RESTORE_SOURCE_OVERLAP')
            require((native.data/'library.json').is_file(),'LEGACY_RESTORE_LIBRARY_REQUIRED')
            plan=build_plan(native.data,max_files=max_files,max_bytes=max_bytes);check()
            with ObjectStore(config,binding) as files:files.write_bytes(stage_key+'/plan.json',serialize_plan(plan),exclusive=True)
            context=dict(id=operation_id,snapshotId=end['id'],sourceFormat='orbita-memory-1',archiveSha256=archive_sha256,archiveTreeHash=end['treeHash'],sourceRoot=end['sourceRoot'],restoredAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),originalValidation=end['validation'],archiveFiles=end['files'],archiveBytes=end['bytes'],archiveEntries=end['entries'])
            def before_publication(event):
                nonlocal readback,application
                check()
                if event['event']=='before-promotion':
                    current=Path(import_stage)/'payload';prefix=stage_key+'/import/payload'
                    with ObjectStore(config,binding) as files:
                        for directory in extracted['directories']:files.mkdir(prefix+'/'+directory,parents=True,exist_ok=True)
                        receipt_key=prefix+'/.orbita-legacy/receipt.json';require(files.stat(receipt_key)['size']<=64*1024**2,'LEGACY_RESTORE_RECEIPT_BUDGET')
                        receipt=json.loads(files.read_bytes(receipt_key))
                    readback=verify_import(plan,receipt,current,config=config,limits=limits)
                    require(readback['custodyBytes']==end['bytes'],'LEGACY_RESTORE_CUSTODY_BYTES')
                    application=application_validation(current,config=config,node=node,deadline=deadline)
                    require(isinstance(end['validation'],dict) and application['conversations']==end['validation'].get('conversations') and application['records']==end['validation'].get('records') and application['originalsVerified'] is True,'LEGACY_RESTORE_APPLICATION_PARITY')
                    with ObjectStore(config,binding) as files:files.write_bytes(stage_key+'/readback.json',stable(dict(readback=readback,application=application)),exclusive=True)
                    check()
                progress(event)
            receipt=import_bundle(plan,destination,import_stage,config=config,limits=limits,vector_extension=vector_extension,progress=before_publication,restore_context=context)
            progress(dict(event='after-promotion',operationId=operation_id));check()
            final_readback=verify_import(plan,receipt,destination,config=config,limits=limits,published=True)
            publication=inspect_restore(destination,operation_id,archive_sha256,config=config)
            require(publication['status']=='PUBLISHED_PAUSED' and publication['receiptSha256']==final_readback['receiptSha256'],'LEGACY_RESTORE_PUBLICATION')
        return dict(status='PASS_EXPLICIT_V1_RESTORE',publication=publication,readback=final_readback,application=application,nativeStageRemoved=True,automaticWork=False,externalAccess=False,humanAcceptance=False)
    finally:
        if authenticated is not None:
            with ObjectStore(config,binding) as files:
                current=files.stat(stage_key+'/cipher/payload')
                require((current['objectId'],current['revision'])==(authenticated['payload']['objectId'],authenticated['payload']['revision']),'LEGACY_PAYLOAD_REPLACED_BEFORE_CLEANUP')
                files.unlink(stage_key+'/cipher/payload')


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=('restore','status'))
    parser.add_argument('--destination',required=True);parser.add_argument('--operation-id',required=True);parser.add_argument('--archive-sha256',required=True)
    parser.add_argument('--archive');parser.add_argument('--stage');parser.add_argument('--private-parent');parser.add_argument('--node');parser.add_argument('--archive-storage',choices=('native','postgresql-common'),default='native')
    args=parser.parse_args(argv)
    try:
        config=read_config()
        if args.action=='status':result=inspect_restore(args.destination,args.operation_id,args.archive_sha256,config=config)
        else:
            require(all((args.archive,args.stage,args.private_parent,args.node)),'LEGACY_RESTORE_ARGUMENTS')
            raw=sys.stdin.buffer.read(8193);require(len(raw)<=8192,'LEGACY_RESTORE_SECRET_INPUT_BUDGET');value=json.loads(raw)
            require(isinstance(value,dict) and set(value)=={'password'},'LEGACY_RESTORE_SECRET_INPUT')
            result=restore_legacy(args.archive,args.archive_sha256,args.destination,args.stage,config=config,node=args.node,password=value['password'],private_parent=args.private_parent,operation_id=args.operation_id,storage=args.archive_storage,vector_extension=os.environ.get('ORBITA_LEGACY_VEC_EXTENSION'))
        print(json.dumps(result));return 0
    except BaseException as error:
        code=str(error) if isinstance(error,StoreError) and re.fullmatch('ORBITA_PG_[A-Z0-9_]+',str(error)) else 'ORBITA_PG_LEGACY_RESTORE_FAILED'
        print(json.dumps(dict(status='FAIL_INSPECT_PUBLICATION_BEFORE_RETRY',code=code,operationId=args.operation_id)));return 1
    finally:close_idle()


if __name__=='__main__':raise SystemExit(main())
