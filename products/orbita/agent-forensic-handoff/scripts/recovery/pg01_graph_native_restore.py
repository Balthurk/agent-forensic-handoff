"""Restore only from the authenticated archive into five newly owned services.

This module never inspects, contacts, stops, or mounts an original service.
Failed destinations, their volumes and all receipts remain available.
"""
from pathlib import Path
import hashlib,json,re,shutil,subprocess,sys,threading,time,uuid
from orbita_store import StoreError
from orbita_store.config import require,plain_local_path
from orbita_store.service_archive import AuthenticatedServiceArchive,canonical,durable_json,private_key
from orbita_store.service_backup import capture
from pg01_graph_restore_layout import CASSANDRA,JANUS,TABLES,available_physical,topology,ttl_horizon
from pg01_graph_restore_memory import MemoryWatch,PROGRAM as MEMORY_PROGRAM
from pg01_graph_content_catalog import full_graph,same_cells
from pg01_graph_expiry import project_native_cells,compare_at_restore
from pg01_restored_graph_http import Janus,SCRIPTS
from pg01_graph_runtime import PROGRAM as RUNTIME_PROGRAM,parse_probe,equivalent

ROOT=Path(__file__).resolve().parent
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
NATIVE_COMMAND="import hashlib,json,os,signal,subprocess,sys,time\na=json.loads(sys.argv[1]);limit=int(sys.argv[2]);begin=time.monotonic();expired=False;p=subprocess.Popen(a,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)\ntry:\n out,err=p.communicate(timeout=limit)\nexcept subprocess.TimeoutExpired:\n expired=True;os.killpg(p.pid,signal.SIGKILL);out,err=p.communicate()\nprint(json.dumps(dict(exit=p.returncode,timedOut=expired,seconds=time.monotonic()-begin,stdout=out[:65536].decode(errors='replace'),stderr=err[:65536].decode(errors='replace'),stdoutBytes=len(out),stderrBytes=len(err),stdoutSha256=hashlib.sha256(out).hexdigest(),stderrSha256=hashlib.sha256(err).hexdigest())))\n"

def restore(directory,*,key_file,private_directory,node,max_seconds=21600,progress=lambda event,**fields:None,expiry_mode='strict'):
    require(expiry_mode in ('strict','at-restore'),'GRAPH_RESTORE_EXPIRY_MODE')
    require(1<=max_seconds<=21600,'GRAPH_RESTORE_DEADLINE')
    require(Path(private_directory).is_absolute(),'GRAPH_RESTORE_ABSOLUTE_PRIVATE_DIRECTORY')
    private=plain_local_path(private_directory);require(private.is_dir() and not any(private.iterdir()),'GRAPH_RESTORE_NEW_PRIVATE_DIRECTORY')
    # Capacity is required before decryption, staging, or any destination service.
    require(available_physical()>=8*1024**3,'GRAPH_RESTORE_INITIAL_HOST_CAPACITY')
    require(shutil.disk_usage(private).free>=60*1024**3,'GRAPH_RESTORE_DISK_RESERVE')
    start=time.monotonic();deadline=start+max_seconds;rid=str(uuid.uuid4());prefix='orbita-graph-restore-'+rid
    key=private_key(key_file);owned=[];networks=[];volumes=[];watch=None;watch_receipt=None;error=None;metadata=None;result={};locked=threading.RLock();aborted=threading.Event();backup_id=None;expiry_projection=None
    def call(command,seconds=30,**kw):
        require(not aborted.is_set(),'GRAPH_RESTORE_RESOURCE_ABORT')
        if watch:watch.check()
        return capture(command,deadline=min(deadline,time.monotonic()+seconds),**kw)
    def inspect(item):
        i=json.loads(capture(['docker','inspect',item['containerId']],deadline=time.monotonic()+15))[0]
        require(i['Id']==item['containerId'] and i['Image']==item['image'] and i['Config']['Labels'].get('orbita.graph-restore')==rid and i['Config']['Labels'].get('orbita.backup')==backup_id,'GRAPH_OWNED_RESTORE_IDENTITY')
        require(i['HostConfig']['Memory']==item['memory'] and i['HostConfig']['MemorySwap']==item['memorySwap'] and i['HostConfig']['NanoCpus']==item['nanoCpus'] and i['HostConfig']['ReadonlyRootfs']==item['readOnlyRoot'],'GRAPH_OWNED_RESOURCE_LIMITS_CHANGED')
        require((i['HostConfig'].get('Tmpfs') or {})==item['tmpfs'],'GRAPH_OWNED_TEMPORARY_MOUNTS_CHANGED')
        require(sorted((m['Type'],m.get('Name'),m['Destination'],m['RW']) for m in i['Mounts'])==sorted((m['type'],m.get('volume'),m['destination'],m['readWrite']) for m in item['mounts']),'GRAPH_OWNED_RESTORE_MOUNTS')
        expected=item['networks'];actual={v['NetworkID'] for v in i['NetworkSettings']['Networks'].values()}
        require(set(i['NetworkSettings']['Networks'])==set(item['networkNames']),'GRAPH_OWNED_RESTORE_NETWORK_NAMES')
        require(actual==set(expected) if i['State']['Running'] else actual-{''}<=set(expected),'GRAPH_OWNED_RESTORE_NETWORKS');return i
    def stop(item,seconds=20):
        with locked:
            i=inspect(item)
            if i['State']['Running']:capture(['docker','stop','--time',str(seconds),item['containerId']],deadline=time.monotonic()+seconds+15)
            final=inspect(item);require(not final['State']['Running'],'GRAPH_OWNED_RESTORE_NOT_STOPPED')
            return dict(containerId=item['containerId'],image=item['image'],stopped=True,exit=final['State']['ExitCode'],oomKilled=final['State']['OOMKilled'])
    def abort_owned():
        aborted.set()
        for item in list(reversed(owned)):
            if item['kind']=='memory':continue
            try:stop(item,3)
            except BaseException:pass
    def remember():durable_json(private/'OWNED.json',dict(restoreId=rid,backupId=backup_id,containers=owned,networks=networks,volumes=volumes))
    def volume(name):
        call(['docker','volume','create','--label','orbita.graph-restore='+rid,'--label','orbita.backup='+backup_id,name])
        info=json.loads(call(['docker','volume','inspect',name]))[0]
        require(info['Name']==name and info['Labels'].get('orbita.graph-restore')==rid and info['Driver']=='local','GRAPH_OWNED_VOLUME')
        volumes.append(dict(name=name,restoreId=rid,backupId=backup_id));remember();return name
    def network(name,internal):
        args=['docker','network','create','--label','orbita.graph-restore='+rid,'--label','orbita.backup='+backup_id]
        if internal:args.append('--internal')
        identifier=call([*args,name]).decode().strip();info=json.loads(call(['docker','network','inspect',identifier]))[0]
        require(info['Id']==identifier and info['Labels'].get('orbita.graph-restore')==rid and info['Internal'] is internal,'GRAPH_OWNED_NETWORK')
        networks.append(dict(id=identifier,name=name,internal=internal));remember();return identifier
    def create(name,image,kind,command,*,mounts=(),network_id=None,env=None,memory=256*1024**2,swap=None,cpus=.5,entrypoint='python3',interactive=False,service=False,publish=False):
        args=['docker','create','--pull=never','--name',name,'--label','orbita.graph-restore='+rid,'--label','orbita.backup='+backup_id,
              '--restart','no','--network',network_id or 'none','--memory',str(memory),'--memory-swap',str(swap or memory),'--cpus',str(cpus)]
        args+=['--log-driver','local','--log-opt','max-size=2m','--log-opt','max-file=2'] if service else ['--log-driver','none']
        if interactive:args.append('--interactive')
        if publish:args+=['--publish','127.0.0.1::8182']
        tmpfs={}
        if not service:
            # JNA needs exec on /tmp; Cassandra's streaming client also creates
            # local system metadata through /opt/cassandra/data -> /var/lib/cassandra.
            # Only the loader gets that bounded writable metadata tmpfs. Archive
            # staging stays read-only; no original service volume is mounted.
            tmpfs={'/tmp':'rw,nosuid,exec,size=64m' if kind=='loader' else 'rw,nosuid,size=64m',
                   '/var/lib/cassandra':'rw,nosuid,noexec,size=64m' if kind=='loader' else 'ro,nosuid,noexec,size=1m'}
            if kind=='loader':tmpfs['/loader-input']='rw,nosuid,noexec,size=128m'
            args+=['--read-only','--pids-limit','128','--user','0','--entrypoint',entrypoint]
            for path,options in tmpfs.items():args+=['--tmpfs',path+':'+options]
        for m in mounts:args+=['--mount','type=volume,source='+m['volume']+',target='+m['destination']+('' if m['readWrite'] else ',readonly')]
        for k,v in (env or {}).items():args+=['--env',k+'='+v]
        cid=call([*args,image,*command]).decode().strip();require(re.fullmatch('[a-f0-9]{64}',cid) is not None,'GRAPH_OWNED_CONTAINER_ID')
        net=json.loads(capture(['docker','network','inspect',network_id or 'none'],deadline=time.monotonic()+15))[0]
        item=dict(containerId=cid,image=image,kind=kind,name=name,restoreId=rid,backupId=backup_id,mounts=[dict(type='volume',**m) for m in mounts],networks=[net['Id']],networkNames=[net['Name']],memory=memory,memorySwap=swap or memory,nanoCpus=int(cpus*10**9),readOnlyRoot=not service,tmpfs=tmpfs)
        with locked:owned.append(item);remember()
        inspect(item);return item
    def native_exec(item,args,limit,label):
        raw=call(['docker','exec',item['containerId'],'python3','-B','-c',NATIVE_COMMAND,json.dumps(args),str(limit)],seconds=limit+20,limit=256*1024)
        value=json.loads(raw);durable_json(private/(label+'.json'),value,exclusive=True);return value
    def native_ok(value):require(value['exit']==0 and not value['timedOut'],'GRAPH_NATIVE_RESTORE_COMMAND_FAILED')
    def start_container(item):call(['docker','start',item['containerId']]);inspect(item)
    def verify_runtime(item,spec,label):
        owner='cassandra' if spec['kind']=='cassandra' else 'janusgraph'
        raw=call(['docker','exec','-i','--user',owner,item['containerId'],'sh','-s'],seconds=20,input_bytes=RUNTIME_PROGRAM.encode(),limit=128*1024)
        value=parse_probe(raw);parity=equivalent(spec['sourceRuntime'],value,spec['kind'])
        durable_json(private/(label+'-runtime.json'),dict(process=value,parity=parity),exclusive=True)
        progress('restored_effective_jvm_configuration_verified',kind=spec['kind'],containerId=item['containerId'],**{k:v for k,v in parity.items() if k!='kind'})
    def keep_logs(item):
        inspect(item)
        process=subprocess.Popen(['docker','logs','--tail','2000',item['containerId']],stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                                 stdin=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            stdout,stderr=process.communicate(timeout=15)
            require(process.returncode==0,'GRAPH_OWNED_LOG_COMMAND_FAILED')
            for label,data in (('stdout',stdout),('stderr',stderr)):
                require(len(data)<=8*1024**2,'GRAPH_OWNED_LOG_BUDGET')
                (private/(item['name']+'-'+label+'.log')).write_bytes(data)
        finally:
            if process.poll() is None:process.kill()
            process.wait(5);process.stdout.close();process.stderr.close()

    try:
        with AuthenticatedServiceArchive(directory,key=key,node=node,deadline=deadline) as archive:
            manifest=archive.manifest;backup_id=manifest['backupId']
            require(manifest.get('sourceKind')=='legacy-janus-cassandra-native-snapshot','GRAPH_NATIVE_ARCHIVE_REQUIRED')
            require(manifest.get('restorationQualified') is False,'GRAPH_BACKUP_MANIFEST_FORMAT')
            metadata_path=private/'archive-metadata.json'
            sink="import hashlib,os,sys\nh=hashlib.sha256();count=0\nwith open(sys.argv[1],'xb') as f:\n while b:=sys.stdin.buffer.read(1048576):\n  count+=len(b);assert count<=268435456;h.update(b);f.write(b)\n f.flush();os.fsync(f.fileno())\nassert h.hexdigest()==sys.argv[2]\n"
            archive.restore_member('globals.enc',[sys.executable,'-I','-B','-c',sink,str(metadata_path),manifest['metadataSha256']])
            require(sha(metadata_path)==manifest['metadataSha256'],'GRAPH_METADATA_DIGEST');metadata=json.loads(metadata_path.read_text())
            require(metadata['backupId']==backup_id and metadata['instanceId']==manifest['instanceId'],'GRAPH_ARCHIVE_METADATA_IDENTITY')
            require(metadata['snapshotFiles']['sha256']==manifest['inventorySha256'] and metadata['beforeCatalog']['logicalSha256']==manifest['nativeLogicalSha256'] and metadata['completeGraph']['sha256']==manifest['graphSha256'],'GRAPH_ARCHIVE_METADATA_BINDING')
            require(metadata.get('runtimeConfiguration',{}).get('sha256')==manifest.get('runtimeConfigurationSha256') and manifest.get('runtimeConfigurationSha256') is not None,'GRAPH_ARCHIVE_RUNTIME_BINDING')
            same_cells(metadata['beforeCatalog'],metadata['afterCatalog'])
            expected_cells=metadata['beforeCatalog']
            if expiry_mode=='strict':
                ttl_horizon(metadata,deadline-time.monotonic())
            else:
                expected_cells,expiry_projection=project_native_cells(metadata['beforeCatalog'],metadata['afterCatalog'],observed_at=time.time(),remaining_seconds=deadline-time.monotonic())
                durable_json(private/'EXPIRY-PROJECTION.json',expiry_projection,exclusive=True)
            images={value['Id']:value for value in json.loads(call(['docker','image','inspect',CASSANDRA,JANUS]))}
            layout=topology(metadata,images,prefix);durable_json(private/'RESTORE-LAYOUT.json',layout,exclusive=True)
            progress('both_members_authenticated_metadata_complete_before_target_creation',backupId=backup_id)
            monitor=create(prefix+'-memory',CASSANDRA,'memory',['-B','-u','-c',MEMORY_PROGRAM],memory=64*1024**2)
            watch=MemoryWatch(monitor['containerId'],abort_owned);watch.admit()
            progress('fresh_capacity_admitted',hostAvailable=watch.samples[0]['hostAvailable'],vmAvailable=watch.samples[0]['vmAvailable'])
            stage_volume=volume(prefix+'-stage')
            stage_mount=[dict(volume=stage_volume,destination='/staging',readWrite=True)]
            extract=create(prefix+'-extract',CASSANDRA,'extract',['-B','-c',(ROOT/'pg01_graph_archive_extract.py').read_text(),manifest['inventorySha256']],mounts=stage_mount,interactive=True)
            inventory_file=private/'snapshot-files.json';durable_json(inventory_file,metadata['snapshotFiles'],exclusive=True)
            call(['docker','cp',str(inventory_file),extract['containerId']+':/staging/snapshot-files.json'])
            archive.restore_member('database.enc',['docker','start','--attach','--interactive',extract['containerId']])
            state=inspect(extract)['State'];require(not state['Running'] and state['ExitCode']==0 and not state['OOMKilled'],'GRAPH_NATIVE_EXTRACTION_FAILED')
            progress('all_native_snapshot_files_extracted_and_byte_verified',files=metadata['snapshotFiles']['inventory']['fileCount'])
            internal=network(prefix+'-internal',True);api=network(prefix+'-api',False);nodes=[]
            for index,spec in enumerate(layout[:3],1):
                data_volume=volume(spec['name']+'-data')
                item=create(spec['name'],spec['image'],'cassandra',spec['command'],mounts=[dict(volume=data_volume,destination='/var/lib/cassandra',readWrite=True)],
                            network_id=internal,env=spec['environment'],memory=spec['memory'],swap=spec['memorySwap'],cpus=spec['cpus'],service=True)
                nodes.append(item);start_container(item);ready=min(deadline,time.monotonic()+600);attempt=0
                while True:
                    attempt+=1;watch.check();require(time.monotonic()<ready,'GRAPH_CASSANDRA_JOIN_TIMEOUT')
                    value=native_exec(item,['nodetool','status'],20,'node'+str(index)+'-ready-'+str(attempt))
                    if value['exit']==0 and not value['timedOut'] and sum(line.strip().startswith('UN ') for line in value['stdout'].splitlines())==index:break
                    time.sleep(2)
                verify_runtime(item,spec,'node'+str(index))
                progress('fresh_cassandra_joined',nodes=index,containerId=item['containerId'])
            schema_file=private/'schema.cql';schema_file.write_text(metadata['beforeCatalog']['logical']['schemaCql'],encoding='utf8')
            call(['docker','cp',str(schema_file),nodes[0]['containerId']+':/tmp/orbita-restore-schema.cql'])
            value=native_exec(nodes[0],['cqlsh','--connect-timeout=5','--request-timeout=8','--file=/tmp/orbita-restore-schema.cql'],120,'schema-restore');native_ok(value)
            progress('complete_native_schema_restored',tables=9)
            ordinal=0
            for source_node in range(1,4):
                for table in TABLES:
                    ordinal+=1;watch.check()
                    files=[f for f in metadata['snapshotFiles']['inventory']['files'] if f['path'].startswith('node'+str(source_node)+'/orbita_f30/'+table+'/') and f['path'].endswith('-Data.db')]
                    if not files:
                        progress('empty_native_snapshot_table',sourceNode=source_node,table=table);continue
                    entries=[{k:f[k] for k in ('path','bytes','sha256')} for f in metadata['snapshotFiles']['inventory']['files'] if f['path'].startswith('node'+str(source_node)+'/orbita_f30/'+table+'/')]
                    request=dict(node=source_node,table=table,entries=entries,nodes=[n['name'] for n in nodes],seconds=180)
                    loader=create(prefix+'-load-'+str(ordinal),CASSANDRA,'loader',['-B','-c',(ROOT/'pg01_graph_loader_workcopy.py').read_text(),json.dumps(request)],
                                  network_id=internal,mounts=[dict(volume=stage_volume,destination='/staging',readWrite=False)],env=dict(MAX_HEAP_SIZE='512M',HEAP_NEWSIZE='128M',JVM_OPTS='-XX:-UseContainerSupport -XX:ActiveProcessorCount=1'),memory=1024**3,cpus=1)
                    value=json.loads(call(['docker','start','--attach',loader['containerId']],seconds=200,limit=256*1024));durable_json(private/('load-'+str(ordinal)+'.json'),value,exclusive=True)
                    native_ok(value);require(not inspect(loader)['State']['Running'],'GRAPH_LOADER_NOT_CLOSED')
                    require(value['sourceAfter']==value['copyBefore']==value['copyAfter'] and value['sourceReadOnly'] and value['copyError'] is None,'GRAPH_LOADER_INPUT_BYTES_CHANGED')
                    progress('native_sstables_loaded',sourceNode=source_node,table=table,sstables=len(files))
            raw=call(['docker','exec','-i','--env','PYTHONDONTWRITEBYTECODE=1',nodes[0]['containerId'],'python3','-',prefix+'-before-janus'],seconds=240,input_bytes=(ROOT/'pg01_cassandra_catalog_probe.py').read_bytes(),limit=64*1024**2)
            restored_cells=json.loads(raw);durable_json(private/'restored-cells-before-janus.json',restored_cells,exclusive=True)
            native_parity=same_cells(expected_cells,restored_cells) if expiry_mode=='strict' else compare_at_restore(expected_cells,restored_cells,expiry_projection)
            durable_json(private/'native-cell-parity.json',native_parity,exclusive=True)
            progress('every_native_cell_and_expiry_verified_before_janus_registration',rows=restored_cells['rows'],typedBytes=restored_cells['typedBytes'])
            janus=[];endpoints=[]
            api_info=next(n for n in networks if n['id']==api)
            for spec in layout[3:]:
                item=create(spec['name'],spec['image'],'janus',spec['command'],network_id=internal,env=spec['environment'],
                            memory=spec['memory'],swap=spec['memorySwap'],cpus=spec['cpus'],service=True,publish=True)
                with locked:
                    call(['docker','network','connect',api,item['containerId']]);item['networks'].append(api);item['networkNames'].append(api_info['name']);remember()
                start_container(item);info=inspect(item);ports=info['NetworkSettings']['Ports']['8182/tcp']
                require(len(ports)==1 and ports[0]['HostIp']=='127.0.0.1' and int(ports[0]['HostPort']) not in (18184,18185),'GRAPH_RESTORED_LOOPBACK_PORT')
                endpoints.append('http://127.0.0.1:'+ports[0]['HostPort']+'/gremlin');janus.append(item)
            client=Janus(dict(endpoints=endpoints));ready=min(deadline,time.monotonic()+600);pending=set(endpoints)
            while pending:
                watch.check();require(time.monotonic()<ready,'GRAPH_RESTORED_JANUS_READY_TIMEOUT')
                for endpoint in list(pending):
                    try:
                        answer=client.request(endpoint,'groovy.json.JsonOutput.toJson([ready:true])',{})
                        if answer==dict(ready=True):pending.remove(endpoint)
                    except StoreError:pass
                if pending:time.sleep(2)
            progress('two_fresh_janus_readers_ready',endpoints=endpoints)
            for index,(item,spec) in enumerate(zip(janus,layout[3:],strict=True),1):verify_runtime(item,spec,'janus'+str(index))
            graph=full_graph(client,SCRIPTS,deadline=min(deadline,time.monotonic()+600),progress=lambda event,**fields:(watch.check(),progress(event,**fields)))
            durable_json(private/'restored-graph-catalog.json',graph,exclusive=True)
            require(graph['readers'][0]['logical']==metadata['completeGraph']['readers'][0]['logical'],'GRAPH_FULL_RESTORED_CONTENT_DIFFERS')
            require(graph['sha256']==manifest['graphSha256'],'GRAPH_RESTORED_CONTENT_DIGEST')
            progress('both_restored_graph_readers_match_every_property_and_edge',vertices=graph['readers'][0]['logical']['vertices'],edges=graph['readers'][0]['logical']['edges'])
            # Re-hash all staged bytes after loaders used their read-only mount.
            verify_code="import hashlib,json,pathlib,sys\nm=json.loads(pathlib.Path('/staging/snapshot-files.json').read_text())['inventory'];count=0\nfor f in m['files']:\n p=pathlib.Path('/staging/data')/f['path'];assert p.is_file() and not p.is_symlink() and p.stat().st_size==f['bytes'];h=hashlib.sha256()\n with p.open('rb') as s:\n  while b:=s.read(1048576):h.update(b)\n assert h.hexdigest()==f['sha256'];count+=1\nprint(json.dumps(dict(status='PASS_ALL_STAGED_BYTES_UNCHANGED',files=count)))\n"
            verifier=create(prefix+'-staged-final',CASSANDRA,'staged-verifier',['-B','-c',verify_code],mounts=[dict(volume=stage_volume,destination='/staging',readWrite=False)])
            staged=json.loads(call(['docker','start','--attach',verifier['containerId']],seconds=120));require(staged['files']==metadata['snapshotFiles']['inventory']['fileCount'],'GRAPH_STAGED_FILE_COUNT')
            require(not inspect(verifier)['State']['Running'],'GRAPH_STAGED_VERIFIER_NOT_CLOSED')
            result=dict(status='PASS_INDEPENDENT_NATIVE_GRAPH_RESTORE' if expiry_mode=='strict' else 'PASS_INDEPENDENT_TEMPORAL_NATIVE_GRAPH_RESTORE',backupId=backup_id,restoreId=rid,nativeCellsEqualBeforeJanus=expiry_projection is None or expiry_projection['expiredCells']==0,fullBothGraphReadersEqual=True,
                        graphSha256=graph['sha256'],nativeLogicalSha256=restored_cells['logicalSha256'],rows=restored_cells['rows'],vertices=graph['readers'][0]['logical']['vertices'],
                        edges=graph['readers'][0]['logical']['edges'],stagedFilesUnchanged=staged,originalAccessRequired=False,
                        janusRegistration='Native cells were compared before either new Janus process started. New runtime instance registrations after that cut are expected and are not silently omitted from native equivalence.')
            if expiry_projection is not None:
                result.update(nativeCellsEqualAtRestoreBeforeJanus=True,expiredCellsExactlyAbsent=expiry_projection['expiredCells'],expiryProjectionSha256=sha(private/'EXPIRY-PROJECTION.json'),nativeCellParity=native_parity)
    except BaseException as caught:
        error=type(caught).__name__+((': '+str(caught)) if isinstance(caught,(AssertionError,StoreError)) else '')
    finally:
        closed=[]
        for item in reversed(owned):
            if item['kind']=='memory':continue
            if item['kind'] in ('cassandra','janus'):
                try:keep_logs(item)
                except BaseException:error=(error or '')+' OWNED_NATIVE_LOG_CAPTURE_FAILED'
            try:
                closed.append(stop(item))
            except BaseException:error=(error or '')+' OWNED_TARGET_CLOSURE_FAILED'
        if watch:
            try:watch_receipt=watch.finish(lambda:stop(monitor,3));durable_json(private/'MEMORY.json',watch_receipt,exclusive=True)
            except BaseException:error=(error or '')+' OWNED_MEMORY_MONITOR_CLOSURE_FAILED'
        for item in owned:
            if item['kind']=='memory':
                try:closed.append(stop(item,3))
                except BaseException:error=(error or '')+' OWNED_MEMORY_PROBE_CLOSURE_FAILED'
        if watch_receipt and watch_receipt['status']!='PASS_OBSERVED_RESERVE':error=(error or '')+' MEMORY_RESERVE_FAILED'
        if any(v['oomKilled'] for v in closed):error=(error or '')+' OWNED_CONTAINER_OOM_KILLED'
        if error:
            result.update(status='FAIL_PRESERVED',nativeCellsEqualBeforeJanus=False,fullBothGraphReadersEqual=False)
            if expiry_mode=='at-restore':result['nativeCellsEqualAtRestoreBeforeJanus']=False
        result.update(seconds=round(time.monotonic()-start,3),error=error,restoreId=rid,backupId=backup_id,ownedContainers=owned,ownedNetworks=networks,ownedVolumes=volumes,
                      closures=closed,memory=({k:v for k,v in watch_receipt.items() if k!='samples'} if watch_receipt else None),
                      sourceServicesAccessed=False,sourceServicesStopped=False,failedArtifactsRetained=True,humanAcceptance=False,expiryMode=expiry_mode)
        durable_json(private/'RESTORE-RESULT.json',result,exclusive=True)
    return result
