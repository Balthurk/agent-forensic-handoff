"""Operator CLI: encrypted complete PostgreSQL service backup and restore.

The source is explicitly identified. Restoration always creates a fresh owned
volume and service from the qualified image; existing databases are never
overwritten. Failed artifacts and stopped restore services remain inspectable.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
import uuid

import psycopg
from psycopg import sql

from . import StoreError
from .admin import connect_operator
from .config import plain_local_path, require
from .service_archive import AuthenticatedServiceArchive, MEMBERS, MANIFEST_LIMIT, _environment, canonical, durable_json, encrypt_member, mac, private_key
from .service_catalog import state as catalog_state, tables, roles
from .service_maintenance import Maintenance, _role, no_clients, recover

IMAGE='sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685'
DATABASE_FORMAT='postgresql-basebackup-tar-with-wal-v1'


def capture(command, *, deadline, limit=32*1024**2, input_bytes=None):
    """Bounded output, generic errors, and an actually retained child handle."""
    require(time.monotonic()<deadline,'SERVICE_DEADLINE')
    require(input_bytes is None or isinstance(input_bytes,bytes) and len(input_bytes)<=8192,'SERVICE_PRIVATE_INPUT_BUDGET')
    child=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL,env=_environment(),creationflags=subprocess.CREATE_NO_WINDOW)
    errors=[];expired=threading.Event();thread=None;timer=None
    def stop():
        if child.poll() is None:child.kill()
    def expire():expired.set();stop()
    def drain():
        count=0
        try:
            while block:=child.stderr.read(4096):
                count+=len(block)
                if count>16384:errors.append('stderr-budget');stop()
        except BaseException:errors.append('stderr-transport');stop()
    try:
        thread=threading.Thread(target=drain,daemon=True);thread.start()
        timer=threading.Timer(max(.001,deadline-time.monotonic()),expire);timer.daemon=True;timer.start()
        if input_bytes is not None:child.stdin.write(input_bytes);child.stdin.close()
        chunks=[];count=0
        while block:=child.stdout.read(65536):
            count+=len(block);require(count<=limit,'SERVICE_CAPTURE_BUDGET');chunks.append(block)
        child.wait(timeout=max(.001,deadline-time.monotonic()));thread.join(5)
        require(not expired.is_set() and time.monotonic()<deadline,'SERVICE_DEADLINE')
        require(child.returncode==0 and not errors and not thread.is_alive(),'SERVICE_COMMAND_FAILED')
        return b''.join(chunks)
    finally:
        if timer:timer.cancel()
        stop();child.wait(5)
        if thread:thread.join(5)
        child.stdout.close();child.stderr.close()
        if child.stdin is not None:child.stdin.close()


def describe_service(cid,operator,*,deadline):
    require(re.fullmatch('[a-f0-9]{64}',cid) is not None,'SERVICE_CONTAINER_ID')
    info=json.loads(capture(['docker','inspect',cid],deadline=deadline))[0]
    require(info['Id']==cid and info['Image']==IMAGE and info['State']['Running'],'SERVICE_CONTAINER_IDENTITY')
    ports=info['NetworkSettings']['Ports']['5432/tcp'];require(ports==[{'HostIp':'127.0.0.1','HostPort':str(operator['port'])}],'SERVICE_LOOPBACK_MAPPING')
    mounts=[m for m in info['Mounts'] if m['Destination']=='/var/lib/postgresql/data']
    require(len(mounts)==1 and mounts[0]['Type']=='volume' and mounts[0]['RW'],'SERVICE_VOLUME_IDENTITY')
    require(info['Config']['Entrypoint']==['docker-entrypoint.sh'],'SERVICE_ENTRYPOINT')
    command=info['Config']['Cmd']
    # The pinned official entrypoint prepends postgres when Cmd starts with
    # options. Keep one effective command for comparison and reconstruction.
    if command and command[0]=='-c':command=['postgres',*command]
    require(command and command[0]=='postgres' and len(command)%2==1,'SERVICE_START_COMMAND')
    for i in range(1,len(command),2):
        require(command[i]=='-c' and re.fullmatch(r'(max_connections|shared_buffers|wal_level|max_wal_size|min_wal_size|checkpoint_timeout|work_mem|maintenance_work_mem)=[A-Za-z0-9]+',command[i+1]),'SERVICE_UNQUALIFIED_START_SETTING')
    require(info['HostConfig']['RestartPolicy']['Name'] in ('no','unless-stopped'),'SERVICE_RESTART_POLICY')
    return dict(containerId=cid,image=info['Image'],volume=mounts[0]['Name'],startedAt=info['State']['StartedAt'],command=command,database=operator['dbname'],port=operator['port'])


def pg_command(service,operator,program,*args):
    require(program in ('pg_dump','pg_dumpall','pg_restore','pg_basebackup','psql'),'SERVICE_POSTGRES_PROGRAM')
    return ['docker','exec','-i',service['containerId'],program,'--no-password','--username='+operator['user'],*args]


def schema(service,operator,backup_id,*,deadline,snapshot=None):
    args=['--schema-only','--create','--dbname='+operator['dbname'],'--restrict-key='+backup_id.replace('-',''),'--lock-wait-timeout=5s']
    if snapshot:args.append('--snapshot='+snapshot)
    return capture(pg_command(service,operator,'pg_dump',*args),deadline=deadline)


def _cluster_check(operator,db):
    require(db.execute("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname NOT IN (%s,'postgres')",(operator['dbname'],)).fetchall()==[],'SERVICE_OTHER_DATABASES_REQUIRE_BACKUP')
    require(db.execute("SELECT count(*) FROM pg_file_settings WHERE applied AND sourcefile LIKE '%postgresql.auto.conf'").fetchone()[0]==0,'SERVICE_UNQUALIFIED_ALTER_SYSTEM')
    if operator['dbname']!='postgres':
        with connect_operator(dict(operator,dbname='postgres')) as administrative:
            require(administrative.execute("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema'").fetchone()[0]==0,'SERVICE_ADMIN_DATABASE_CONTENT')
            require(administrative.execute("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema'").fetchone()[0]==0,'SERVICE_ADMIN_DATABASE_CONTENT')
            require(administrative.execute("SELECT count(*) FROM pg_namespace WHERE nspname!~'^pg_' AND nspname NOT IN ('public','information_schema')").fetchone()[0]==0,'SERVICE_ADMIN_DATABASE_CONTENT')


def physical_member(service,operator,path,*,node,key,backup_id,instance_id,deadline):
    tag='orbita-service-backup-'+backup_id
    with connect_operator(operator) as db:
        began=db.execute('SELECT clock_timestamp()').fetchone()[0]
        require(db.execute('SELECT count(*) FROM pg_stat_activity WHERE application_name=%s',(tag,)).fetchone()[0]==0,'SERVICE_BACKUP_IDENTITY_COLLISION')
    try:
        return encrypt_member(path,pg_command(service,operator,'pg_basebackup','--format=tar','--pgdata=-','--wal-method=fetch','--checkpoint=fast','--manifest-checksums=SHA256','--dbname=application_name='+tag,'--label='+tag),
                              node=node,key=key,backup_id=backup_id,instance_id=instance_id,deadline=deadline)
    finally:
        # Closing a docker client alone does not prove closure inside its server.
        # Only this invocation's fresh, nonce-bound replication backend is ours.
        with connect_operator(operator) as db:
            db.execute("SET statement_timeout='3s'")
            rows=db.execute("SELECT pid,backend_start FROM pg_stat_activity WHERE application_name=%s AND usename=%s AND backend_type='walsender' AND backend_start>=%s",(tag,operator['user'],began)).fetchall()
            require(len(rows)<=1,'SERVICE_BACKUP_BACKEND_IDENTITY')
            for pid,started in rows:
                db.execute("SELECT pg_terminate_backend(pid,1000) FROM pg_stat_activity WHERE pid=%s AND backend_start=%s AND application_name=%s AND usename=%s AND backend_type='walsender'",(pid,started,tag,operator['user'])).fetchall()
            db.execute('SELECT pg_stat_clear_snapshot()')
            require(db.execute('SELECT count(*) FROM pg_stat_activity WHERE application_name=%s',(tag,)).fetchone()[0]==0,'SERVICE_BACKUP_BACKEND_NOT_CLOSED')


def await_catalog_reader_closed(db, identity, *, deadline):
    """Confirm server-side exit of our closed reader, never drain other clients.

    libpq close can return before PostgreSQL removes its backend. The identity
    was read from that live connection, before closing it. A reused PID or any
    other client remains a failure. This consumes the existing operation budget.
    The caller still runs the unchanged strict no_clients check afterwards.
    """
    deadline=min(deadline,time.monotonic()+5)
    previous=db.execute('SHOW statement_timeout').fetchone()[0]
    while True:
        remaining=deadline-time.monotonic()
        require(remaining>0,'SERVICE_READER_CLOSE_DEADLINE')
        db.execute("SELECT set_config('statement_timeout',%s,true)",(str(max(1,int(remaining*1000)))+'ms',))
        db.execute('SELECT pg_stat_clear_snapshot()')
        rows=db.execute("SELECT pid,backend_start FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()").fetchall()
        require(time.monotonic()<deadline,'SERVICE_READER_CLOSE_DEADLINE')
        require(not rows or rows==[identity],'SERVICE_CLIENTS_ACTIVE')
        if not rows:
            db.execute("SELECT set_config('statement_timeout',%s,true)",(previous,))
            return
        time.sleep(min(.01,max(0,deadline-time.monotonic())))


def backup(operator,*,container_id,destination,key_file,intent,node,max_seconds=21600,progress=lambda event:None):
    require(1<=max_seconds<=21600,'SERVICE_DEADLINE_BUDGET')
    deadline=time.monotonic()+max_seconds;destination=plain_local_path(destination);key_file=plain_local_path(key_file);intent=plain_local_path(intent)
    require(not destination.exists() and not intent.exists(),'SERVICE_DESTINATION_EXISTS')
    require(key_file.parent!=destination and intent.parent!=destination,'SERVICE_PRIVATE_ARTIFACT_SEPARATION')
    service=describe_service(container_id,operator,deadline=deadline);backup_id=str(uuid.uuid4())
    key=private_key(key_file,create=True)
    with connect_operator(operator) as db:
        db.execute("SET timezone='UTC'");no_clients(db);_cluster_check(operator,db)
        instance=db.execute('SELECT instance_id::text FROM orbita_common.identity').fetchone()[0]
        require(instance==operator['instanceId'],'SERVICE_INSTANCE_CHANGED')
        size=db.execute('SELECT pg_database_size(current_database())').fetchone()[0]
        require(shutil.disk_usage(destination.parent).free>=55*1024**3+3*size,'SERVICE_DISK_RESERVE')
        original_role=_role(db,key,'orbita_runtime');enumerated=tables(db);original_roles=roles(db,key)
        source_bootstrap=db.execute('SELECT rolname FROM pg_authid WHERE oid=10 AND rolsuper').fetchone()
        require(source_bootstrap is not None and re.fullmatch('[a-z_][a-z0-9_]{0,62}',source_bootstrap[0]),'SERVICE_BOOTSTRAP_IDENTITY');source_bootstrap=source_bootstrap[0]
    destination.mkdir()
    globals_member=encrypt_member(destination/MEMBERS[0],pg_command(service,operator,'pg_dumpall','--globals-only','--quote-all-identifiers'),
                                  node=node,key=key,backup_id=backup_id,instance_id=instance,deadline=deadline)
    progress('globals_encrypted')
    with Maintenance(operator,instance_id=instance,service=service,intent=intent,key=key,backup_id=backup_id,expected_role=original_role,progress=progress) as maintenance:
        db=maintenance.db;db.execute("SET timezone='UTC'");db.execute("SET statement_timeout='600s'");db.execute("SET lock_timeout='5s'")
        db.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        # LOCK precedes the first snapshot-taking SELECT. The list was acquired
        # outside this transaction; drift after lock acquisition is rejected.
        db.execute(sql.SQL('LOCK TABLE {} IN SHARE MODE').format(sql.SQL(',').join(sql.Identifier(*name) for name in enumerated)))
        require(tables(db)==enumerated,'SERVICE_TABLE_INVENTORY_CHANGED')
        snapshot=db.execute('SELECT pg_export_snapshot()').fetchone()[0]
        progress('snapshot_locked')
        schema_before=schema(service,operator,backup_id,deadline=deadline,snapshot=snapshot)
        with connect_operator(operator) as sequence_reader:
            before=catalog_state(db,key=key,schema_bytes=schema_before,runtime_login=original_role['login'],deadline=deadline,sequence_reader=sequence_reader)
        require(before['roles']==original_roles,'SERVICE_GLOBAL_ROLES_CHANGED')
        database_member=physical_member(service,operator,destination/MEMBERS[1],node=node,key=key,backup_id=backup_id,instance_id=instance,deadline=deadline)
        progress('database_encrypted')
        # Fresh independent connection while all data locks remain held.
        fresh_schema=schema(service,operator,backup_id,deadline=deadline)
        with connect_operator(operator) as fresh:
            fresh.execute("SET timezone='UTC'");fresh.execute("SET statement_timeout='600s'")
            after=catalog_state(fresh,key=key,schema_bytes=fresh_schema,runtime_login=original_role['login'],deadline=deadline)
            require(before==after,'SERVICE_SOURCE_CHANGED_DURING_BACKUP')
            reader_identity=fresh.execute('SELECT pid,backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()').fetchone()
        await_catalog_reader_closed(db,reader_identity,deadline=deadline)
        maintenance.verify_role();no_clients(db)
        require(describe_service(container_id,operator,deadline=deadline)==service,'SERVICE_CONTAINER_CHANGED')
        db.commit()
    # Only a successfully recovered source and two completed producers publish.
    require(time.monotonic()<deadline,'SERVICE_DEADLINE')
    manifest=dict(schema=2,backupId=backup_id,instanceId=instance,database=operator['dbname'],service=service,sourceBootstrapRole=source_bootstrap,
                  databaseFormat=DATABASE_FORMAT,runtimeLogin=original_role['login'],
                  members=[globals_member,database_member],catalog=before,sourceRecovery=maintenance.recovery)
    require(len(canonical(dict(payload=manifest,hmac=mac(key,manifest))))+1<=MANIFEST_LIMIT,'SERVICE_MANIFEST_BUDGET')
    durable_json(destination/'manifest.json',dict(payload=manifest,hmac=mac(key,manifest)),exclusive=True)
    return dict(status='COMPLETE_SERVICE_BACKUP_ENCRYPTED',backupId=backup_id,instanceId=instance,directory=str(destination),
                keyFile=str(key_file),recoveryIntent=str(intent),tables=len(before['tables']),bytes=sum(m['bytes'] for m in manifest['members']),
                sourceRecovery=maintenance.recovery,independentRestorePending=True)


def stop_owned_restore(receipt,*,deadline):
    info=json.loads(capture(['docker','inspect',receipt['containerId']],deadline=deadline))[0]
    require(info['Id']==receipt['containerId'] and info['Image']==IMAGE and
            info['Config']['Labels'].get('orbita.service-restore')==receipt['restoreId'] and
            info['Config']['Labels'].get('orbita.backup')==receipt['backupId'] and
            any(m.get('Name')==receipt['volume'] for m in info['Mounts']),'SERVICE_RESTORE_OWNERSHIP')
    if info['State']['Running']:capture(['docker','stop','--time','10',receipt['containerId']],deadline=deadline)
    require(not json.loads(capture(['docker','inspect',receipt['containerId']],deadline=deadline))[0]['State']['Running'],'SERVICE_RESTORE_STILL_RUNNING')
    return dict(containerId=receipt['containerId'],stopped=True,volumeRetained=receipt['volume'])


def volume_helper(owned, program, arguments, *, deadline):
    """A pinned, networkless native utility with a durable owned identity."""
    require(program in ('tar','pg_verifybackup'),'SERVICE_VOLUME_PROGRAM')
    cid=capture(['docker','create','--interactive','--pull=never','--network=none','--user=0','--restart=no',
                 '--label','orbita.service-restore='+owned['restoreId'],'--label','orbita.backup='+owned['backupId'],
                 '--mount','type=volume,source='+owned['volume']+',target=/var/lib/postgresql/data',
                 '--entrypoint',program,IMAGE,*arguments],deadline=deadline).decode().strip()
    require(re.fullmatch('[a-f0-9]{64}',cid),'SERVICE_HELPER_CONTAINER')
    return dict(owned,containerId=cid,program=program)


def restore(directory,*,key_file,private_directory,node,max_seconds=21600,progress=lambda event:None):
    require(1<=max_seconds<=21600,'SERVICE_DEADLINE_BUDGET')
    deadline=time.monotonic()+max_seconds;private_directory=plain_local_path(private_directory)
    require(not private_directory.exists(),'SERVICE_RESTORE_DIRECTORY_EXISTS');key=private_key(key_file)
    owned=None;helpers=[]
    # ALL authentication precedes even creation of the SQL target.
    with AuthenticatedServiceArchive(directory,key=key,node=node,deadline=deadline) as archive:
        progress('all_members_authenticated');m=archive.manifest
        require(m['service']['image']==IMAGE,'SERVICE_RESTORE_IMAGE')
        require(m.get('databaseFormat')==DATABASE_FORMAT,'SERVICE_RESTORE_DATABASE_FORMAT')
        require(type(m.get('runtimeLogin')) is bool,'SERVICE_RESTORE_AUTHORITY')
        require(shutil.disk_usage(private_directory.parent).free>=55*1024**3+2*m['members'][1]['plaintextBytes'],'SERVICE_RESTORE_DISK_RESERVE')
        private_directory.mkdir();restore_id=str(uuid.uuid4());name='orbita-service-restore-'+restore_id;volume=name+'-data'
        bootstrap='orbita_restore_'+secrets.token_hex(12)
        require(bootstrap not in m['catalog']['roles']['roles'],'SERVICE_BOOTSTRAP_COLLISION')
        password=secrets.token_urlsafe(40)
        labels=['--label','orbita.service-restore='+restore_id,'--label','orbita.backup='+m['backupId']]
        capture(['docker','volume','create',*labels,volume],deadline=deadline)
        cid=capture(['docker','create','--pull=never','--name',name,*labels,'--restart=no',
                     '--mount','type=volume,source='+volume+',target=/var/lib/postgresql/data','--publish','127.0.0.1::5432',IMAGE,*m['service']['command']],deadline=deadline).decode().strip()
        require(re.fullmatch('[a-f0-9]{64}',cid),'SERVICE_RESTORE_CONTAINER')
        owned=dict(containerId=cid,volume=volume,restoreId=restore_id,backupId=m['backupId'],image=IMAGE)
        durable_json(private_directory/'OWNED-SERVICE.json',owned,exclusive=True)
        try:
            extract=volume_helper(owned,'tar',['--extract','--file=-','--directory=/var/lib/postgresql/data','--numeric-owner'],deadline=deadline);helpers.append(extract)
            durable_json(private_directory/'OWNED-HELPERS.json',helpers)
            archive.restore_member('database.enc',['docker','start','--attach','--interactive',extract['containerId']])
            require(json.loads(capture(['docker','inspect',extract['containerId']],deadline=deadline))[0]['State']['ExitCode']==0,'SERVICE_EXTRACTION_FAILED')
            extract['closure']=stop_owned_restore(extract,deadline=deadline)
            verify=volume_helper(owned,'pg_verifybackup',['--exit-on-error','/var/lib/postgresql/data'],deadline=deadline);helpers.append(verify)
            durable_json(private_directory/'OWNED-HELPERS.json',helpers)
            capture(['docker','start','--attach',verify['containerId']],deadline=deadline)
            require(json.loads(capture(['docker','inspect',verify['containerId']],deadline=deadline))[0]['State']['ExitCode']==0,'SERVICE_NATIVE_BACKUP_VERIFICATION_FAILED')
            verify['closure']=stop_owned_restore(verify,deadline=deadline)
            durable_json(private_directory/'OWNED-HELPERS.json',helpers)
            progress('native_backup_and_wal_verified')
            capture(['docker','start',cid],deadline=deadline)
            info=json.loads(capture(['docker','inspect',cid],deadline=deadline))[0];ports=info['NetworkSettings']['Ports']['5432/tcp']
            require(len(ports)==1 and ports[0]['HostIp']=='127.0.0.1','SERVICE_RESTORE_LOOPBACK')
            operator=dict(host='127.0.0.1',port=int(ports[0]['HostPort']),dbname='postgres',user=bootstrap,password=password,instanceId=m['instanceId'])
            durable_json(private_directory/'operator.json',dict(operator,dbname=m['database']),exclusive=True)
            ready=min(deadline,time.monotonic()+60)
            while True:
                result=json.loads(capture(['docker','inspect',cid],deadline=deadline))[0]
                require(result['State']['Running'],'SERVICE_RESTORE_NOT_RUNNING')
                # pg_isready does not change role credentials or require them.
                try:capture(['docker','exec',cid,'pg_isready','--quiet','--username='+m['sourceBootstrapRole'],'--dbname=postgres'],deadline=min(deadline,time.monotonic()+5));break
                except StoreError:
                    require(time.monotonic()<ready,'SERVICE_RESTORE_START_TIMEOUT');time.sleep(.1)
            service=describe_service(cid,operator,deadline=deadline)
            require(service['port']!=m['service']['port'] and service['volume']!=m['service']['volume'],'SERVICE_RESTORE_NOT_INDEPENDENT')
            require(m['sourceBootstrapRole'] in m['catalog']['roles']['roles'],'SERVICE_SOURCE_BOOTSTRAP_ROLE')
            # Native recovery preserves all OIDs, roles, grantors and passwords.
            # Only the archived maintenance NOLOGIN is undone on this new target.
            # The temporary operator's secret travels through stdin, never argv.
            bootstrap_sql=sql.SQL('CREATE ROLE {} LOGIN SUPERUSER PASSWORD {}; ALTER ROLE orbita_runtime {};').format(
                sql.Identifier(bootstrap),sql.Literal(password),sql.SQL('LOGIN' if m['runtimeLogin'] else 'NOLOGIN')).as_string().encode('utf8')
            native_operator=dict(operator,user=m['sourceBootstrapRole'])
            capture(pg_command(service,native_operator,'psql','--dbname=postgres','--no-psqlrc','--set=ON_ERROR_STOP=1','--single-transaction'),deadline=deadline,input_bytes=bootstrap_sql)
            operator['dbname']=m['database'];service=describe_service(cid,operator,deadline=deadline)
            restored_schema=schema(service,operator,m['backupId'],deadline=deadline)
            with connect_operator(operator) as db:
                require(db.execute('SELECT instance_id::text FROM orbita_common.identity').fetchone()[0]==m['instanceId'],'SERVICE_RESTORE_INSTANCE')
                require(db.execute('SELECT rolname FROM pg_authid WHERE oid=10').fetchone()[0]==m['sourceBootstrapRole'],'SERVICE_BOOTSTRAP_OID_CHANGED')
                actual=catalog_state(db,key=key,schema_bytes=restored_schema,exclude_roles=(bootstrap,),deadline=deadline)
                durable_json(private_directory/'COMPARISON.json',dict(expected=m['catalog'],actual=actual,equal=actual==m['catalog']),exclusive=True)
                require(actual==m['catalog'],'SERVICE_RESTORE_CATALOG_OR_DATA_MISMATCH');no_clients(db)
            result=dict(status='PASS_INDEPENDENT_COMPLETE_SERVICE_RESTORE',**owned,service=service,operatorConfig=str(private_directory/'operator.json'),
                        tables=len(actual['tables']),sequences=len(actual['sequences']),schemaSha256=actual['schemaSha256'],databaseFormat=DATABASE_FORMAT,
                        nativeVerification='PASS_PG_VERIFYBACKUP_ALL_FILES_AND_WAL',helperClosures=helpers,running=True,sourceUnmodified=True,humanAcceptance=False)
            durable_json(private_directory/'RESTORE.json',result,exclusive=True)
            return result
        except BaseException:
            for helper in helpers:helper['closure']=stop_owned_restore(helper,deadline=max(deadline,time.monotonic()+20))
            durable_json(private_directory/'OWNED-HELPERS.json',helpers)
            closure=stop_owned_restore(owned,deadline=max(deadline,time.monotonic()+20))
            durable_json(private_directory/'FAILED-RESTORE.json',dict(status='FAIL_PRESERVED',**owned,closure=closure),exclusive=True)
            raise


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='action',required=True)
    b=sub.add_parser('backup');b.add_argument('--operator',required=True);b.add_argument('--container',required=True);b.add_argument('--destination',required=True);b.add_argument('--intent',required=True)
    r=sub.add_parser('restore');r.add_argument('--directory',required=True);r.add_argument('--private-directory',required=True)
    recovery=sub.add_parser('recover');recovery.add_argument('--operator',required=True);recovery.add_argument('--container',required=True);recovery.add_argument('--intent',required=True)
    stop=sub.add_parser('stop-restored');stop.add_argument('--receipt',required=True);stop.add_argument('--max-seconds',type=int,default=30)
    for child in (b,r,recovery):child.add_argument('--key-file',required=True);child.add_argument('--node',required=True);child.add_argument('--max-seconds',type=int,default=21600)
    args=parser.parse_args(argv)
    try:
        if args.action=='stop-restored':
            require(1<=args.max_seconds<=30,'SERVICE_DEADLINE_BUDGET')
            receipt=json.loads(plain_local_path(args.receipt).read_text(encoding='utf8'))
            result=stop_owned_restore(receipt,deadline=time.monotonic()+args.max_seconds)
        elif args.action=='restore':result=restore(args.directory,key_file=args.key_file,private_directory=args.private_directory,node=args.node,max_seconds=args.max_seconds)
        else:
            operator=json.loads(plain_local_path(args.operator).read_text(encoding='utf8'))
            if args.action=='backup':result=backup(operator,container_id=args.container,destination=args.destination,key_file=args.key_file,intent=args.intent,node=args.node,max_seconds=args.max_seconds)
            else:
                service=describe_service(args.container,operator,deadline=time.monotonic()+30)
                result=recover(operator,instance_id=operator['instanceId'],service=service,intent=args.intent,key=private_key(args.key_file))
        print(json.dumps(result));return 0
    except BaseException as error:
        code=str(error) if isinstance(error,StoreError) and re.fullmatch('ORBITA_PG_[A-Z0-9_]+',str(error)) else 'ORBITA_PG_SERVICE_OPERATION_FAILED'
        sqlstate=getattr(error,'sqlstate',None)
        print(json.dumps(dict(status='FAIL_PRESERVED',error=code,errorType=type(error).__name__,sqlstate=sqlstate if isinstance(sqlstate,str) and re.fullmatch('[A-Z0-9]{5}',sqlstate) else None)));return 1


if __name__=='__main__':raise SystemExit(main())
