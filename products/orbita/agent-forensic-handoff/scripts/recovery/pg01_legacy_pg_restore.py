"""Restore a legacy PG archive without reading or connecting to its original.

The operator input supplies only the archived login/database. All connections
use the newly allocated loopback destination. An empty single-user recovery
uses native Linux syncfs, then exits cleanly; the normal server starts with the
archived command and its complete configuration is compared without omissions.
"""
from pathlib import Path
import ctypes, datetime, hashlib, json, re, shutil, time, uuid
import psycopg
from orbita_store import StoreError
from orbita_store.config import require
from orbita_store.legacy_sqlite import NativeReadHold
from orbita_store.service_archive import AuthenticatedServiceArchive, canonical, durable_json, mac, private_key
from orbita_store.service_backup import IMAGE, capture, schema, stop_owned_restore, volume_helper
from orbita_store.service_catalog import state as small_catalog
from pg01_legacy_catalog import state as large_catalog

SHA=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
NOW=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
TEMPLATE0='Physical archive, pg_verifybackup file/WAL validation; no source ALTER DATABASE or connection enabled.'

def catalog_bytes_equal(restored, authenticated_bytes):
    # The native reader returns column tuples; the authenticated JSON stores
    # arrays. Compare the complete canonical bytes produced by durable_json,
    # including every field and its order, without dropping or masking data.
    return canonical(restored)+b'\n' == authenticated_bytes

def connect(parameters,tag):
    return psycopg.connect(**{k:parameters[k] for k in ('host','port','dbname','user','password')},
                           connect_timeout=5,autocommit=True,application_name=tag)

def cluster(parameters,tag,system_id,key):
    with connect(parameters,tag) as db:
        db.execute("SET statement_timeout='10s'")
        require(db.execute("SELECT count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND backend_type IN ('client backend','walsender')").fetchone()[0]==0,'LEGACY_RESTORE_OTHER_CLIENTS')
        require(db.execute("SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global')").fetchone()[0]==0,'LEGACY_EXTERNAL_TABLESPACE')
        require(db.execute('SELECT count(*) FROM pg_replication_slots').fetchone()[0]==0,'LEGACY_REPLICATION_SLOT')
        require(db.execute("SELECT count(*) FROM pg_file_settings WHERE applied AND sourcefile LIKE '%postgresql.auto.conf'").fetchone()[0]==0,'LEGACY_ALTER_SYSTEM')
        require(all(db.execute('SHOW '+s).fetchone()[0]=='on' for s in ('fsync','full_page_writes','synchronous_commit')),'LEGACY_DURABILITY_DISABLED')
        require(db.execute('SHOW recovery_init_sync_method').fetchone()[0]=='fsync','LEGACY_TEMPORARY_RECOVERY_SETTING_REMAINED')
        identity=db.execute('SELECT system_identifier::text FROM pg_control_system()').fetchone()[0]
        require(identity==system_id,'LEGACY_CLUSTER_IDENTITY_CHANGED')
        databases=db.execute('SELECT datname,pg_get_userbyid(datdba),encoding,datlocprovider,datcollate,datctype,daticulocale,daticurules,datcollversion,datistemplate,datallowconn,datconnlimit,datacl::text FROM pg_database ORDER BY datname').fetchall()
        settings=db.execute('SELECT setdatabase,setrole,setconfig FROM pg_db_role_setting ORDER BY 1,2').fetchall()
        return dict(systemIdentifier=identity,databases=[list(x) for x in databases],databaseRoleSettingsHmac=mac(key,settings))

def catalog(parameters,svc,manifest,key,deadline,progress):
    tag=svc['readApplicationName']; meta=cluster(parameters,tag,svc['systemIdentifier'],key); values={}
    for row in meta['databases']:
        database=row[0]
        if not row[10]:
            require(database=='template0' and row[9],'LEGACY_UNCONNECTABLE_USER_DATABASE')
            continue
        actual=dict(parameters,dbname=database)
        with connect(actual,tag) as db:
            db.execute("SET statement_timeout='60s'");db.execute("SET lock_timeout='5s'")
            if manifest['sourceKind']=='legacy-semantic-postgresql':
                values[database]=large_catalog(db,svc,actual,manifest['backupId'],key=key,deadline=deadline,
                    progress=lambda **kw:progress(kw.pop('event'),phase='restored',database=database,**kw))
            else:
                raw=schema(svc,actual,manifest['backupId'],deadline=deadline)
                values[database]=small_catalog(db,key=key,schema_bytes=raw,deadline=deadline)
        progress('catalog_database',phase='restored',database=database,tables=len(values[database]['tables']))
    require(cluster(parameters,tag,svc['systemIdentifier'],key)==meta,'LEGACY_RESTORE_METADATA_DRIFT')
    return dict(cluster=meta,databases=values,nonConnectableTemplate0=TEMPLATE0)

def restore(directory,*,key_file,catalog_file,operator_file,private_directory,node,max_seconds=21600,memory_mib=512,progress=lambda event,**fields:None):
    require(1<=max_seconds<=21600,'LEGACY_RESTORE_DEADLINE_BUDGET')
    require(type(memory_mib) is int and memory_mib in (512,2048),'LEGACY_RESTORE_MEMORY_BUDGET')
    started=time.monotonic();deadline=started+max_seconds
    private=Path(private_directory);require(private.is_dir() and not (private/'OWNED-SERVICE.json').exists(),'LEGACY_RESTORE_PRIVATE_DESTINATION')
    key=private_key(key_file); source_operator=json.loads(Path(operator_file).read_text())
    require(source_operator['user']=='postgres','LEGACY_ARCHIVED_OPERATOR')
    owned=None;helpers=[];close=None;error=None;result={}
    def inspect(cid):return json.loads(capture(['docker','inspect',cid],deadline=min(deadline,time.monotonic()+20)))[0]
    def save_helpers():durable_json(private/'OWNED-HELPERS.json',helpers)
    def native_helper(program,args,*,interactive=False):
        require(program in ('postgres','pg_controldata','cat'),'LEGACY_RECOVERY_HELPER_PROGRAM')
        require(program!='cat' or args==['/proc/meminfo'],'LEGACY_CAPACITY_HELPER_SCOPE')
        command=['docker','create','--pull=never','--network=none','--user='+('0' if program=='postgres' else 'postgres'),'--restart=no','--memory=512m',
                 '--env','LC_ALL=C','--label','orbita.service-restore='+owned['restoreId'],
                 '--label','orbita.backup='+owned['backupId'],'--mount','type=volume,source='+owned['volume']+',target=/var/lib/postgresql/data',
                 '--entrypoint','docker-entrypoint.sh' if program=='postgres' else program]
        if interactive:command.append('--interactive')
        # The official entrypoint prepares a freshly allocated volume's root
        # permissions/ownership before dropping to postgres. Never bypass it
        # for single-user recovery of a tar extracted into a new Docker volume.
        cid=capture([*command,IMAGE,*(['postgres'] if program=='postgres' else []),*args],deadline=deadline).decode().strip()
        require(re.fullmatch('[a-f0-9]{64}',cid),'LEGACY_RECOVERY_HELPER_ID')
        item=dict(owned,containerId=cid,program=program);helpers.append(item);save_helpers();return item
    try:
        with AuthenticatedServiceArchive(directory,key=key,node=node,deadline=deadline) as archive:
            manifest=archive.manifest;svc=manifest['service']
            require(manifest.get('databaseFormat')=='legacy-postgresql-basebackup-tar-with-wal-v1' and
                    manifest.get('sourceKind') in ('legacy-semantic-postgresql','legacy-volume-postgresql'),'LEGACY_ARCHIVE_FORMAT')
            require(svc['image']==IMAGE and svc['command']==['postgres'],'LEGACY_ARCHIVE_IMAGE_OR_COMMAND')
            require(manifest.get('identityKind')=='custody-uuid5-from-postgresql-system-identifier-not-common-store' and
                    manifest['instanceId']==str(uuid.uuid5(uuid.NAMESPACE_URL,'orbita-legacy-postgresql:'+svc['systemIdentifier'])),'LEGACY_CUSTODY_IDENTITY')
            require(source_operator['dbname']==svc['database'],'LEGACY_ARCHIVED_DATABASE')
            with NativeReadHold(catalog_file,max_bytes=256*1024**2) as held:
                catalog_bytes=held.file.read(256*1024**2+1);require(len(catalog_bytes)<=256*1024**2,'LEGACY_CATALOG_BUDGET')
                expected=json.loads(catalog_bytes)
                if manifest['sourceKind']=='legacy-semantic-postgresql':
                    require(hashlib.sha256(catalog_bytes).hexdigest()==manifest['catalogSha256'],'LEGACY_CATALOG_AUTHENTICATION')
                else:require(expected==manifest['catalog'],'LEGACY_CATALOG_AUTHENTICATION')
                require(expected['cluster']['systemIdentifier']==svc['systemIdentifier'],'LEGACY_CATALOG_IDENTITY')
            progress('all_members_and_catalog_authenticated_before_target_creation')
            member=next(m for m in manifest['members'] if m['name']=='database.enc')
            require(shutil.disk_usage(private).free>=55*1024**3+2*member['plaintextBytes'],'LEGACY_RESTORE_DISK_RESERVE')
            kernel=capture(['docker','info','--format','{{.KernelVersion}}'],deadline=deadline).decode().strip()
            version=re.match(r'^(\d+)\.(\d+)',kernel)
            require(version is not None and tuple(map(int,version.groups()))>=(5,8),'LEGACY_SYNCFS_KERNEL_ERROR_REPORTING')
            restore_id=str(uuid.uuid4());name='orbita-legacy-pg-restore-'+restore_id;volume=name+'-data'
            labels=['--label','orbita.service-restore='+restore_id,'--label','orbita.backup='+manifest['backupId']]
            capture(['docker','volume','create',*labels,volume],deadline=deadline)
            owned=dict(volume=volume,restoreId=restore_id,backupId=manifest['backupId'],image=IMAGE)
            durable_json(private/'OWNED-SERVICE.json',owned,exclusive=True)
            cid=capture(['docker','create','--pull=never','--name',name,*labels,'--restart=no','--memory='+str(memory_mib)+'m',
                         '--mount','type=volume,source='+volume+',target=/var/lib/postgresql/data','--publish','127.0.0.1::5432',IMAGE,'postgres'],deadline=deadline).decode().strip()
            require(re.fullmatch('[a-f0-9]{64}',cid),'LEGACY_RESTORE_CONTAINER_ID')
            owned['containerId']=cid;durable_json(private/'OWNED-SERVICE.json',owned)
            extract=volume_helper(owned,'tar',['--extract','--file=-','--directory=/var/lib/postgresql/data','--numeric-owner'],deadline=deadline)
            helpers.append(extract);save_helpers()
            archive.restore_member('database.enc',['docker','start','--attach','--interactive',extract['containerId']])
            require(inspect(extract['containerId'])['State']['ExitCode']==0,'LEGACY_EXTRACTION_FAILED')
            extract['closure']=stop_owned_restore(extract,deadline=deadline);save_helpers()
            verify=volume_helper(owned,'pg_verifybackup',['--exit-on-error','/var/lib/postgresql/data'],deadline=deadline)
            helpers.append(verify);save_helpers()
            capture(['docker','start','--attach',verify['containerId']],deadline=deadline)
            require(inspect(verify['containerId'])['State']['ExitCode']==0,'LEGACY_NATIVE_VERIFICATION_FAILED')
            verify['closure']=stop_owned_restore(verify,deadline=deadline);save_helpers()
            progress('pg_verifybackup_all_files_and_wal_passed')
            capacity=native_helper('cat',['/proc/meminfo'])
            raw=capture(['docker','start','--attach',capacity['containerId']],deadline=min(deadline,time.monotonic()+10)).decode()
            vm_available=int(re.search(r'^MemAvailable:\s+(\d+)',raw,re.M).group(1))*1024
            class Memory(ctypes.Structure):
                _fields_=[('length',ctypes.c_ulong),('load',ctypes.c_ulong)]+[(n,ctypes.c_ulonglong) for n in ('totalPhys','availPhys','totalPageFile','availPageFile','totalVirtual','availVirtual','availExtendedVirtual')]
            memory=Memory();memory.length=ctypes.sizeof(memory)
            require(ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(memory))!=0,'LEGACY_RESTORE_HOST_MEMORY_READ')
            require(memory.availPhys>=2*1024**3 and vm_available>=(memory_mib+2048)*1024**2,'LEGACY_RESTORE_MEMORY_RESERVE')
            capacity['closure']=stop_owned_restore(capacity,deadline=deadline);save_helpers()
            progress('restore_memory_admitted',targetMemoryMiB=memory_mib,hostAvailableBytes=memory.availPhys,vmAvailableBytes=vm_available)
            recovery=native_helper('postgres',['--single','-D','/var/lib/postgresql/data','-c','recovery_init_sync_method=syncfs','postgres'],interactive=True)
            control=native_helper('pg_controldata',['/var/lib/postgresql/data'])
            # The original total 60-second readiness allowance covers recovery,
            # its clean-stop verification, and starting the unmodified server.
            recovery_start=time.monotonic();ready=min(deadline,recovery_start+60)
            output=capture(['docker','start','--attach','--interactive',recovery['containerId']],input_bytes=b'',deadline=ready)
            durable_json(private/'RECOVERY-OUTPUT.json',dict(stdoutBytes=len(output),sha256=hashlib.sha256(output).hexdigest(),inputBytes=0,kernel=kernel))
            state=inspect(recovery['containerId'])['State']
            require(not state['Running'] and state['ExitCode']==0 and not state['OOMKilled'],'LEGACY_NATIVE_RECOVERY_FAILED')
            recovery['closure']=stop_owned_restore(recovery,deadline=ready);save_helpers()
            control_text=capture(['docker','start','--attach',control['containerId']],deadline=ready).decode()
            require(re.search(r'^Database cluster state:\s+shut down\s*$',control_text,re.M),'LEGACY_RECOVERY_NOT_CLEANLY_STOPPED')
            control['closure']=stop_owned_restore(control,deadline=ready);save_helpers()
            progress('native_syncfs_recovery_cleanly_stopped',secondsSinceRecoveryStart=round(time.monotonic()-recovery_start,3),kernel=kernel)
            capture(['docker','start',cid],deadline=ready)
            target=inspect(cid);ports=target['NetworkSettings']['Ports']['5432/tcp']
            require(target['State']['Running'] and target['Image']==IMAGE and target['Config']['Cmd']==['postgres'] and len(ports)==1 and ports[0]['HostIp']=='127.0.0.1','LEGACY_RESTORE_IDENTITY')
            port=int(ports[0]['HostPort']);require(port not in (15436,15437,15438),'LEGACY_RESTORE_NOT_INDEPENDENT')
            parameters=dict(host='127.0.0.1',port=port,dbname=source_operator['dbname'],user=source_operator['user'],password=source_operator['password'])
            durable_json(private/'restored-operator.json',parameters,exclusive=True)
            while True:
                try:
                    capture(['docker','exec',cid,'pg_isready','--quiet','--username=postgres','--dbname=postgres'],deadline=min(ready,time.monotonic()+5));break
                except StoreError:
                    require(time.monotonic()<ready,'LEGACY_RESTORE_READY_TIMEOUT');time.sleep(.1)
            progress('normal_server_ready_with_original_command',secondsSinceRecoveryStart=round(time.monotonic()-recovery_start,3),limitSeconds=60)
            restored_svc=dict(svc,containerId=cid,port=port,storage='named-volume',volume=volume,readApplicationName='orbita-legacy-restore-'+restore_id)
            restored=catalog(parameters,restored_svc,manifest,key,deadline,progress)
            durable_json(private/'restored-catalog.json',restored,exclusive=True)
            require(catalog_bytes_equal(restored,catalog_bytes),'LEGACY_RESTORED_COMPLETE_CATALOG_OR_CONTENT_MISMATCH')
            result=dict(status='PASS_INDEPENDENT_ARCHIVE_ONLY_LEGACY_PG_RESTORE',completeCatalogEqual=True,
                        catalogSha256=SHA(private/'restored-catalog.json'),sourceKind=manifest['sourceKind'],backupId=manifest['backupId'],
                        databases=len(restored['databases']),tables=sum(len(d['tables']) for d in restored['databases'].values()),
                        originalAccessRequired=False,readinessLimitSeconds=60,temporaryRecoverySettingPersisted=False,memoryLimitMiB=memory_mib)
    except BaseException as caught:
        error=type(caught).__name__+((': '+str(caught)) if isinstance(caught,(AssertionError,StoreError)) else '')
    finally:
        for item in helpers:
            try:item['closure']=stop_owned_restore(item,deadline=time.monotonic()+30)
            except BaseException:error=(error or '')+' OWNED_HELPER_CLOSURE_FAILED'
        if helpers:save_helpers()
        if owned and owned.get('containerId'):
            try:close=stop_owned_restore(owned,deadline=time.monotonic()+30)
            except BaseException:error=(error or '')+' OWNED_RESTORE_CLOSURE_FAILED'
        if error:result.update(status='FAIL_PRESERVED',completeCatalogEqual=False)
        result.update(at=NOW(),seconds=round(time.monotonic()-started,3),error=error,restoredService=owned,
                      restoreServiceClosure=close,utilityClosures=helpers,humanAcceptance=False)
        durable_json(private/'RESTORE-RESULT.json',result,exclusive=True)
    return result
