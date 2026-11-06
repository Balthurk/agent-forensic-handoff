"""Run the three discovered PostgreSQL suites with isolated per-file test scopes.

Adapted from the delivered source checker and PG01 cumulative fixture runner.
Private input files remain outside the source checkout. Failed evidence and
new test volumes are retained; this command never retires existing services.
"""
from pathlib import Path
import argparse,ctypes,datetime,hashlib,json,os,re,secrets,shutil,subprocess,sys,time,uuid

ROOT=Path(__file__).resolve().parents[2]
PACKAGE=ROOT/'agent-forensic-handoff'
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()

SOURCE_SUFFIXES=frozenset(('.py','.mjs','.js','.cjs','.html','.css','.json','.jsonl',
    '.ps1','.psm1','.psd1','.cmd','.bat','.sh','.sql','.txt','.md','.ts','.tsx','.jsx',
    '.yaml','.yml','.zip'))


def covered_source(relative):
    return bool(relative.parts) and relative.parts[0] in ('app','agent-forensic-handoff') and (
        relative.suffix.lower() in SOURCE_SUFFIXES or relative.name.casefold() in ('.gitignore','license'))


def available_memory():
    class Memory(ctypes.Structure):
        _fields_=[('length',ctypes.c_ulong),('load',ctypes.c_ulong)]+[(n,ctypes.c_ulonglong) for n in ('totalPhys','availPhys','totalPageFile','availPageFile','totalVirtual','availVirtual','availExtendedVirtual')]
    value=Memory();value.length=ctypes.sizeof(value)
    assert ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(value)),'HOST_MEMORY_UNAVAILABLE'
    return value.availPhys


def discovery():
    groups=dict(core=sorted((PACKAGE/'test').glob('*.test.js')),app=sorted((ROOT/'app').glob('*.test.mjs')),python=sorted((PACKAGE/'python').glob('test_*.py')))
    assert all(groups.values()),'TEST_DISCOVERY_EMPTY'
    return groups


def source_manifest(path):
    from orbita_store.config import plain_local_path
    value=json.loads(path.read_text(encoding='utf8'));result={}
    for row in value['files']:
        relative=Path(row['path'])
        assert not relative.is_absolute() and '..' not in relative.parts,'SOURCE_MANIFEST_PATH'
        file=plain_local_path(ROOT/relative)
        assert file.is_file() and not file.is_symlink(),'SOURCE_MANIFEST_FILE'
        digest=sha(file);assert digest==row['publishedCandidateSha256'],'SOURCE_MANIFEST_MISMATCH'
        assert row['path'].casefold() not in {name.casefold() for name in result},'SOURCE_MANIFEST_DUPLICATE'
        result[row['path']]=digest
    assert result,'SOURCE_MANIFEST_EMPTY'
    # Compare the same boundary on disk and in the manifest. Auxiliary launchers,
    # fixture archives and licenses belong to the source export as well.
    # Every manifest member is hashed above, including members outside this boundary.
    observed=set()
    for folder,dirs,names in os.walk(ROOT,followlinks=False):
        dirs[:]=[name for name in dirs if name not in ('node_modules','__pycache__','.git','data')]
        for name in names:
            file=Path(folder)/name;relative=file.relative_to(ROOT)
            if covered_source(relative):
                observed.add(relative.as_posix())
    expected={name for name in result if covered_source(Path(name))}
    assert observed==expected,'SOURCE_MANIFEST_INCOMPLETE'
    return result


def execution_plan(groups,node,profile):
    if profile=='local-serial':
        values=[(suite+'-'+file.stem,[str(node),'--test','--test-concurrency=1','--test-reporter=tap',str(file)],PACKAGE if suite=='core' else ROOT,suite,file.relative_to(ROOT).as_posix())
                for suite in ('core','app') for file in groups[suite]]
    else:
        values=[(suite,[str(node),'--test','--test-reporter=tap',*map(str,groups[suite])],PACKAGE if suite=='core' else ROOT,suite,None) for suite in ('core','app')]
    return [*values,('python',[sys.executable,'-X','utf8','-B','-m','unittest','discover','-s',str(PACKAGE/'python'),'-p','test_*.py','-v'],ROOT,'python',None)]


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--list',action='store_true')
    parser.add_argument('--profile',choices=('original','local-serial'),default='original',help='local-serial: one Node file at a time, all tests, 900s per file and a 7200s total execution budget; internal deadlines are unchanged.')
    parser.add_argument('--preflight',action='store_true',help='Validate inputs without provisioning test scopes or starting services.')
    for key in ('lab','private-directory','operator','runtime','real-f35','real-f36','p1-fixture','i05-oracle','vec-extension','model-home','node'):
        parser.add_argument('--'+key,type=Path)
    parser.add_argument('--manifest',type=Path,default=ROOT/'SOURCE-MANIFEST.json')
    args=parser.parse_args(argv);groups=discovery()
    if args.list:
        print(json.dumps({k:[p.relative_to(ROOT).as_posix() for p in files] for k,files in groups.items()},indent=2));return 0
    assert os.name=='nt' and sys.version_info>=(3,12),'WINDOWS_PYTHON_3_12_REQUIRED'
    assert all(getattr(args,key) is not None for key in ('lab','private_directory','operator','runtime','real_f35','real_f36','p1_fixture','i05_oracle','vec_extension','model_home','node')),'ALL_EXPLICIT_INPUTS_REQUIRED'
    sys.path.insert(0,str(PACKAGE/'python'))
    from orbita_store.config import plain_local_path,parse_config
    from orbita_store.admin import connect_operator,provision_workspace
    from orbita_store.schema import install_family
    from orbita_store.service_archive import durable_json
    from orbita_store.service_backup import IMAGE,capture
    for key,value in vars(args).items():
        if isinstance(value,Path):
            assert value.is_absolute(),'ABSOLUTE_PATH_REQUIRED:'+key
            setattr(args,key,plain_local_path(value))
    for key in ('operator','runtime','real_f35','real_f36','vec_extension','node','manifest'):
        assert getattr(args,key).is_file(),'INPUT_FILE_REQUIRED:'+key
    for key in ('operator','runtime','real_f35','real_f36'):
        assert not getattr(args,key).is_relative_to(ROOT),'PRIVATE_INPUT_INSIDE_SOURCE:'+key
    for key in ('p1_fixture','i05_oracle','model_home'):
        assert getattr(args,key).is_dir(),'INPUT_DIRECTORY_REQUIRED:'+key
    for path in (args.lab,args.private_directory):
        assert not path.exists() and path.parent.is_dir() and not path.is_relative_to(ROOT),'NEW_EXTERNAL_DIRECTORY_REQUIRED'
    assert not args.lab.is_relative_to(args.private_directory) and not args.private_directory.is_relative_to(args.lab),'SEPARATE_PRIVATE_AND_LOG_DIRECTORIES'
    operator=json.loads(args.operator.read_text(encoding='utf8'));base=json.loads(args.runtime.read_text(encoding='utf8'));config=parse_config(base)
    assert tuple(operator[k] for k in ('host','port','dbname'))==tuple(base[k] for k in ('host','port','dbname')),'OPERATOR_RUNTIME_TARGET_MISMATCH'
    for path in (args.real_f35,args.real_f36):
        value=parse_config(json.loads(path.read_text(encoding='utf8')));assert len(value.bindings)==1,'REAL_CONTROL_PROFILE_REQUIRED'
    before=source_manifest(args.manifest)
    for files in groups.values():
        assert all(p.relative_to(ROOT).as_posix() in before for p in files),'UNDOCUMENTED_DISCOVERED_TEST'
    for file in (Path(__file__),Path(__file__).with_name('node-case-preload.mjs'),ROOT/'app/owned-process.mjs'):
        assert file.relative_to(ROOT).as_posix() in before,'CHECKER_SOURCE_NOT_MANIFESTED'
    with connect_operator(operator) as db:
        assert db.execute('SELECT instance_id::text FROM orbita_common.identity').fetchone()[0]==config.instance_id,'INSTANCE_MISMATCH'
        assert db.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'").fetchone()[0]==0,'COMMON_CLIENTS_ACTIVE'
        assert all(db.execute('SHOW '+key).fetchone()[0]=='on' for key in ('fsync','full_page_writes','synchronous_commit')),'DURABILITY_REQUIRED'
    assert json.loads(capture(['docker','image','inspect',IMAGE],deadline=time.monotonic()+15))[0]['Id']==IMAGE,'EXACT_LOCAL_IMAGE_REQUIRED'
    assert capture([str(args.node),'--version'],deadline=time.monotonic()+15).decode().strip()=='v24.20.0','QUALIFIED_NODE_VERSION_REQUIRED'
    resources=dict(hostAvailableBytes=available_memory(),minimumHostBytes=8*1024**3,freeDiskBytes=shutil.disk_usage(args.lab.parent).free,minimumDiskBytes=60*1024**3)
    assert resources['hostAvailableBytes']>=resources['minimumHostBytes'] and resources['freeDiskBytes']>=resources['minimumDiskBytes'],'INSUFFICIENT_RESOURCES'
    if args.preflight:
        print(json.dumps(dict(status='PASS_INPUT_PREFLIGHT_ONLY',profile=args.profile,files={k:len(v) for k,v in groups.items()},resources=resources,humanAcceptance=False)));return 0
    lab=args.lab;private=args.private_directory;lab.mkdir();private.mkdir();run_id=str(uuid.uuid4());at=now();started=time.monotonic()
    roots=[];workspaces=[];suites=[];errors=[];cid=None;service=None;service_closed=None;common_closed=None;test_children_started=False
    total_deadline=started+7200 if args.profile=='local-serial' else None
    commands=execution_plan(groups,args.node,args.profile)
    service_name='orbita-cumulative-installation-'+run_id;volume=service_name+'-data'
    installation=dict(host='127.0.0.1',dbname='orbita_installation',user='orbita_install_owner',password=secrets.token_urlsafe(40),runtimePassword=secrets.token_urlsafe(40),instanceId=str(uuid.uuid4()))
    durable_json(lab/'RESOURCES.json',resources)

    def command(values,seconds=30):return capture(values,deadline=time.monotonic()+seconds)
    def identity():
        value=json.loads(command(['docker','inspect',cid]))[0]
        assert value['Id']==cid and value['Image']==IMAGE and value['Config']['Labels'].get('orbita.run')==run_id,'OWNED_SERVICE_IDENTITY'
        assert value['Name']=='/'+service_name and any(m['Type']=='volume' and m['Name']==volume and m['Destination']=='/var/lib/postgresql/data' for m in value['Mounts']),'OWNED_SERVICE_VOLUME'
        assert value['HostConfig']['RestartPolicy']['Name']=='no','OWNED_SERVICE_RESTART_POLICY'
        return value
    def profile(key,path,kind='test',extra=None):
        roots.append(path);ws=provision_workspace(operator,label='qualification:'+run_id+':'+key,kind=kind);workspaces.append(ws['workspaceId']);bindings=[dict(root=str(path),**ws)]
        if extra is not None:
            other=provision_workspace(operator,label='qualification:'+run_id+':'+key+':native-attack',kind='test');workspaces.append(other['workspaceId']);bindings.append(dict(root=str(extra),**other))
        file=private/(key+'.json');durable_json(file,dict(base,bindings=bindings));durable_json(lab/'FIXTURES.json',dict(runId=run_id,workspaceIds=workspaces,virtualRoots=list(map(str,roots))));return str(file)
    def no_clients(parameters,instance):
        with connect_operator(parameters) as db:
            assert db.execute('SELECT instance_id::text FROM orbita_common.identity').fetchone()[0]==instance,'CLOSURE_INSTANCE_MISMATCH'
            deadline=time.monotonic()+5
            while True:
                db.execute('SELECT pg_stat_clear_snapshot()')
                rows=db.execute("SELECT pid,backend_start::text,application_name,state FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'").fetchall()
                if not rows or time.monotonic()>=deadline:break
                time.sleep(.01)
            return dict(at=now(),instanceId=instance,activeBackends=len(rows),backends=rows)
    try:
        with connect_operator(operator) as db:
            for family,source in [('f35_fixture','CREATE TABLE retained(value TEXT);'),('recovery_fixture','CREATE TABLE history(version INTEGER,payload TEXT); CREATE TABLE jobs(id TEXT,status TEXT);')]:
                db.execute('INSERT INTO orbita_private.families(name) VALUES(%s) ON CONFLICT DO NOTHING',(family,));install_family(db,family,source)
        temp=lab/'native-temp';temp.mkdir();virtual=lab/'python-virtual'
        env={k:v for k,v in os.environ.items() if k.lower() in ('systemroot','windir','comspec','path','pathext','temp','tmp','lang','lc_all','tz')}
        env.update(PYTHONDONTWRITEBYTECODE='1',PYTHONUTF8='1',PYTHONPATH=str(PACKAGE/'python'),ORBITA_POSTGRES_PYTHON=sys.executable,AFH_PYTHON=sys.executable,AFH_VOLUME_PYTHON=sys.executable,AFH_SQLITE_PYTHON=sys.executable,AFH_SEMANTIC_PYTHON=sys.executable,AFH_MODEL_HOME=str(args.model_home),ORBITA_POSTGRES_TEST_ROOT=str(virtual),ORBITA_POSTGRES_TEST_RECEIPTS=str(lab),ORBITA_POSTGRES_TEST_OPERATOR_CONFIG=str(args.operator),ORBITA_POSTGRES_TEST_CONFIG=str(args.runtime),ORBITA_TEST_NODE=str(args.node),ORBITA_TEST_I05_ORACLE=str(args.i05_oracle),ORBITA_LEGACY_VEC_EXTENSION=str(args.vec_extension),AFH_I03_CANDIDATE=str(ROOT),AFH_P1_REAL_FIXTURE=str(args.p1_fixture),ORBITA_STARTUP_TEST_PRIVATE=str(private),TEMP=str(temp),TMP=str(temp),AFH_TEST_ROOT=str(temp),PATH=str(args.node.parent)+os.pathsep+str(Path(sys.executable).parent)+os.pathsep+env.get('PATH',''))
        env['ORBITA_POSTGRES_CONFIG']=profile('python',virtual)
        scopes={}
        for file in [*groups['core'],*groups['app']]:
            key=hashlib.sha256(file.relative_to(ROOT).as_posix().encode()).hexdigest()[:20];receipts=lab/'node-files'/key;receipts.mkdir(parents=True);native=receipts/'native-temp';native.mkdir();root=receipts/'virtual';attack=receipts/'native-path-safety' if file.name=='access.test.mjs' else None
            scope=dict(ORBITA_POSTGRES_CONFIG=profile(key,root,extra=attack),ORBITA_POSTGRES_TEST_ROOT=str(root),ORBITA_POSTGRES_TEST_RECEIPTS=str(receipts),AFH_TEST_ROOT=str(native),TEMP=str(native),TMP=str(native))
            if attack is not None:scope['ORBITA_POSTGRES_TEST_NATIVE_ROOT']=str(attack)
            scopes[str(file.resolve()).lower()]=scope
        scope_file=lab/'NODE-SCOPES.json';durable_json(scope_file,scopes);env.update(ORBITA_TEST_CASE_MAP=str(scope_file),NODE_OPTIONS='--import='+Path(__file__).with_name('node-case-preload.mjs').as_uri())
        profiles={key:profile('startup-'+key,lab/'startup'/key/'virtual',kind) for key,kind in [('personal','personal'),('control','control'),('emptyControl','control')]}
        profiles.update(realF35=str(args.real_f35),realF36=str(args.real_f36));index=lab/'STARTUP-PROFILES.json';durable_json(index,profiles);env['ORBITA_STARTUP_TEST_PROFILES']=str(index)
        assert service_name not in command(['docker','container','ls','--all','--format','{{.Names}}']).decode().splitlines(),'SERVICE_NAME_ALREADY_EXISTS'
        assert volume not in command(['docker','volume','ls','--format','{{.Name}}']).decode().splitlines(),'VOLUME_NAME_ALREADY_EXISTS'
        env_file=private/'installation.env';env_file.write_text('POSTGRES_DB=orbita_installation\nPOSTGRES_USER=orbita_install_owner\nPOSTGRES_PASSWORD='+installation['password']+'\n',encoding='utf8')
        durable_json(lab/'ISOLATED-SERVICE-INTENT.json',dict(runId=run_id,name=service_name,volume=volume,image=IMAGE))
        command(['docker','volume','create','--label','orbita.run='+run_id,volume])
        cid=command(['docker','create','--pull=never','--name',service_name,'--label','orbita.run='+run_id,'--restart=no','--env-file',str(env_file),'--mount','type=volume,source='+volume+',target=/var/lib/postgresql/data','--publish','127.0.0.1::5432',IMAGE,'-c','max_connections=250','-c','shared_buffers=128MB']).decode().strip();assert re.fullmatch('[a-f0-9]{64}',cid),'OWNED_SERVICE_ID'
        identity();durable_json(lab/'ISOLATED-SERVICE-OWNED.json',dict(runId=run_id,containerId=cid,name=service_name,volume=volume,image=IMAGE))
        command(['docker','start',cid])
        info=identity();ports=info['NetworkSettings']['Ports']['5432/tcp'];assert len(ports)==1 and ports[0]['HostIp']=='127.0.0.1';installation['port']=int(ports[0]['HostPort']);assert installation['port']!=config.port and installation['port']!=15438,'ISOLATED_INSTALLATION_PORT'
        operator_file=private/'installation-operator.json';durable_json(operator_file,installation);env['ORBITA_INSTALLATION_TEST_OPERATOR']=str(operator_file)
        deadline=time.monotonic()+60
        while True:
            try:
                with connect_operator(installation) as db:assert db.execute('SHOW fsync').fetchone()[0]==db.execute('SHOW full_page_writes').fetchone()[0]=='on'
                break
            except Exception:
                if time.monotonic()>=deadline:raise AssertionError('ISOLATED_STARTUP_TIMEOUT')
                time.sleep(.2)
        service=dict(runId=run_id,containerId=cid,name=service_name,volume=volume,image=IMAGE,port=installation['port'],instanceId=installation['instanceId'],operatorConfig=str(operator_file));description=lab/'ISOLATED-SERVICE.json';durable_json(description,service);env['ORBITA_SERVICE_TEST_DESCRIPTION']=str(description)
        # Reuse the application's qualified owned-process transport for actual
        # child closure, including its Windows descendant timeout handling.
        wrapper=lab/'run-suite.mjs';wrapper.write_text("import fs from 'node:fs';import {runOwnedProcess} from "+json.dumps((ROOT/'app/owned-process.mjs').as_uri())+";const request=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));try{const value=await runOwnedProcess(request.command[0],request.command.slice(1),{env:process.env,cwd:request.cwd,timeout:request.timeoutMs,stdoutLimit:32*1024**2,stderrLimit:32*1024**2,totalLimit:32*1024**2});fs.writeFileSync(request.receipt,JSON.stringify(value),{flag:'wx'});}catch(error){fs.writeFileSync(request.receipt,JSON.stringify({...(error.capture??{}),failure:error.message}),{flag:'wx'});process.exitCode=1;}\n",encoding='utf8')
        durable_json(lab/'EXECUTION-PLAN.json',dict(profile=args.profile,totalBudgetSeconds=7200 if total_deadline else None,perCommandSeconds=900,commands=[dict(name=n,command=c,cwd=str(w),suite=g,file=f) for n,c,w,g,f in commands]))
        for name,command_line,cwd,suite,file in commands:
            began=time.monotonic();remaining=900 if total_deadline is None else min(900,total_deadline-began)
            assert remaining>0,'TOTAL_EXECUTION_BUDGET_EXHAUSTED'
            request=lab/(name+'-request.json');capture_file=lab/(name+'-capture.json');durable_json(request,dict(command=command_line,cwd=str(cwd),receipt=str(capture_file),timeoutMs=max(1,int(remaining*1000))))
            durable_json(lab/'ACTIVE-COMMAND.json',dict(name=name,suite=suite,file=file,startedAt=now(),secondsAllowed=remaining))
            with (lab/(name+'-supervisor.log')).open('xb') as stream:
                test_children_started=True
                child=subprocess.Popen([str(args.node),str(wrapper),str(request)],env=env,cwd=ROOT,stdout=stream,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW)
                try:child.wait(timeout=remaining+30)
                except subprocess.TimeoutExpired:
                    if child.poll() is None:subprocess.run(['taskkill','/PID',str(child.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15,creationflags=subprocess.CREATE_NO_WINDOW)
                    child.wait(5);raise AssertionError('SUITE_SUPERVISOR_TIMEOUT')
            captured=json.loads(capture_file.read_text());output=captured.get('stdout','')+'\n'+captured.get('stderr','');log=lab/(name+'.log');log.write_text(output,encoding='utf8');code=captured.get('code')
            if not captured.get('closed') or captured.get('failure') or captured.get('signal'):errors.append(name+':OWNED_PROCESS_FAILURE')
            if suite=='python':
                count=re.search(r'Ran (\d+) tests? in ',output);count=int(count[1]) if count else 0;skipped=sum(map(int,re.findall(r'skipped=(\d+)',output)));passed=count-skipped if code==0 else None
                if not re.search(r'^OK(?:\s*\([^\n]*\))?\s*$',output,re.M):errors.append(name+':NOT_OK')
            else:
                def metric(key):
                    values=re.findall(r'^# '+key+r' (\d+)$',output,re.M);return int(values[-1]) if values else -1
                count,passed,skipped=metric('tests'),metric('pass'),metric('skipped')
                if any(metric(k)!=0 for k in ('fail','cancelled','todo')) or passed!=count-skipped:errors.append(name+':FAILED_OR_INCOMPLETE')
            expected_skip=1 if suite=='core' and (file is None or Path(file).name=='security.test.js') else 0
            if expected_skip and re.findall(r'^ok \d+ - (.*?) # SKIP[^\n]*$',output,re.M)!=['symlink transcript input is refused by default']:errors.append(name+':UNEXPECTED_SKIP')
            if code or count<=0 or skipped!=expected_skip:errors.append(name+':EXIT_COUNT_OR_SKIP')
            suites.append(dict(name=name,suite=suite,file=file,exit=code,tests=count,passed=passed,skipped=skipped,seconds=round(time.monotonic()-began,3),logSha256=sha(log),ownedCaptureSha256=sha(capture_file)));durable_json(lab/'PROGRESS.json',dict(profile=args.profile,completedCommands=len(suites),plannedCommands=len(commands),suites=suites,errors=errors));print(json.dumps(suites[-1]),flush=True)
            common_closed=no_clients(operator,config.instance_id)
            if common_closed['activeBackends']:raise AssertionError('SUITE_CLIENTS_REMAIN')
    except BaseException as error:
        errors.append('CHECK_FAILED:'+type(error).__name__+(':'+str(error) if isinstance(error,AssertionError) else ''))
    finally:
        if cid is None and (lab/'ISOLATED-SERVICE-INTENT.json').is_file():
            try:
                found=command(['docker','container','ls','--all','--no-trunc','--filter','name=^/'+service_name+'$','--format','{{.ID}}']).decode().splitlines()
                assert len(found)<=1 and all(re.fullmatch('[a-f0-9]{64}',value) for value in found),'OWNED_SERVICE_RECOVERY_ID'
                if found:cid=found[0];identity()
            except BaseException as error:errors.append('ISOLATED_ID_RECOVERY_FAILED:'+type(error).__name__)
        if cid is not None:
            try:
                info=identity()
                # A failed installation may not have created identity yet.
                if test_children_started:
                    with connect_operator(installation) as db:
                        live=db.execute("SELECT pid,backend_start::text,application_name,state FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'").fetchall()
                    assert not live,'ISOLATED_CLIENTS_REMAIN'
                if info['State']['Running']:command(['docker','stop','--time','15',cid])
                final=identity();assert not final['State']['Running'];service_closed=dict(containerId=cid,stopped=True,image=IMAGE,volumeRetained=volume)
            except BaseException as error:errors.append('ISOLATED_CLOSURE_FAILED:'+type(error).__name__)
        try:
            common_closed=no_clients(operator,config.instance_id)
            if common_closed['activeBackends']:errors.append('COMMON_CLIENTS_REMAIN')
        except BaseException as error:errors.append('COMMON_CLOSURE_FAILED:'+type(error).__name__)
        if len(suites)!=len(commands):errors.append('DISCOVERED_SUITE_COVERAGE_INCOMPLETE')
        if any(path.exists() for path in roots):errors.append('NATIVE_OPERATIONAL_OUTPUT')
        if any(not (ROOT/relative).is_file() or sha(ROOT/relative)!=digest for relative,digest in before.items()):errors.append('SOURCES_CHANGED')
        result=dict(at=at,finishedAt=now(),status='FAIL_PRESERVED' if errors else 'PASS_FULL_DISCOVERED_CUMULATIVE',seconds=round(time.monotonic()-started,3),runId=run_id,suites=suites,errors=errors,sourceFiles=before,executionProfile=args.profile,totalBudgetSeconds=7200 if total_deadline else None,plannedCommands=len(commands),completedCommands=len(suites),discoveredFiles={k:len(v) for k,v in groups.items()},commonSqlClosure=common_closed,isolatedService=service,isolatedServiceClosure=service_closed,scope=('Three complete discovered suites; one Node file active at a time, original internal test/child deadlines,900s per command and7200s total execution budget. Cleanup may extend after execution deadline.' if args.profile=='local-serial' else 'Three complete source suites, original Node concurrency and900s per suite.')+' Real UI, full F36 and operational custody remain separate.',humanAcceptance=False)
        durable_json(lab/'RESULT.json',result,exclusive=True)
    return int(bool(errors))


if __name__=='__main__':
    raise SystemExit(main())
