"""Explicit operator publication of already imported, independently read stages.

No SQLite reader, renewal, login, provider call or native content path belongs
here. Original typed control rows stay byte-for-byte unchanged. Publication
rotates staging capabilities and records its outcome in the same transaction.
An interrupted call must be resolved with publication_receipt before retrying.
"""
import hashlib
import json
import re
import secrets
import uuid

from psycopg import sql
from .admin import connect_operator
from .config import require


def _uuid(value):
    require(isinstance(value,str) and str(uuid.UUID(value))==value,'MIGRATION_UUID')
    return value


def _hash(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode('utf8')).hexdigest()


def _ids(control,children):
    _uuid(control)
    require(isinstance(children,dict) and 0<len(children)<=1000,'MIGRATION_CHILDREN')
    for local,child in children.items():
        require(isinstance(local,str) and re.fullmatch(r'ws-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',local),'MIGRATION_LOCAL_ID')
        _uuid(child)
    result=sorted([control,*children.values()])
    require(len(set(result))==len(result),'MIGRATION_DUPLICATE_WORKSPACE')
    return result


def _operator(parameters,instance_id):
    db=connect_operator(parameters)
    try:
        require(db.execute('SELECT instance_id::text FROM orbita_common.identity').fetchone()==(_uuid(instance_id),),'MIGRATION_INSTANCE')
        db.execute("SET lock_timeout='10s'")
        db.execute("SET statement_timeout='60s'")
        db.execute("SET timezone='UTC'")
        return db
    except BaseException:
        db.close();raise


def _locks(db,ids):
    for wid in ids:
        db.execute("SELECT pg_advisory_xact_lock(hashtextextended('managed-admission:'||%s,0))",(wid,))


def _stages(db,ids,*,frozen):
    rows=db.execute('SELECT id::text,kind,parent_id,active FROM orbita_private.workspaces WHERE id=ANY(%s::uuid[]) ORDER BY id FOR UPDATE',(ids,)).fetchall()
    require(len(rows)==len(ids) and all(r[1]=='personal' and r[2] is None and (not frozen or not r[3]) for r in rows),'MIGRATION_STAGE_REQUIRED')
    require(not db.execute('SELECT 1 FROM orbita_private.workspaces WHERE parent_id=ANY(%s::uuid[]) LIMIT 1',(ids,)).fetchone(),'MIGRATION_STAGE_HAS_CHILDREN')
    require(not db.execute('SELECT 1 FROM orbita_private.managed_workspaces WHERE workspace_id=ANY(%s::uuid[]) LIMIT 1',(ids,)).fetchone(),'MIGRATION_STAGE_ALREADY_MANAGED')


def _no_consumers(db,ids):
    db.execute('SELECT pg_stat_clear_snapshot()')
    # Every writer_path has an FK to its object_pin, checked here as well.
    for table in ('sessions','object_pins','store_leases'):
        query=sql.SQL('SELECT 1 FROM orbita_private.{} s JOIN pg_stat_activity a ON a.pid=s.pid AND a.backend_start=s.backend_start WHERE s.workspace_id=ANY(%s::uuid[]) LIMIT 1').format(sql.Identifier(table))
        require(not db.execute(query,(ids,)).fetchone(),'MIGRATION_LIVE_CONSUMER')


def _manifest(db,ids):
    """Digest every scoped content table, including object bytes and row IDs.

    Database JSON encoding preserves typed values here; this digest compares
    two reads of the same staged DB, not SQLite-to-PG semantic equivalence.
    Ephemeral consumers and authority are checked separately, never imported.
    """
    omit={'sessions','object_pins','store_leases','writer_paths','managed_workspaces','managed_legacy_archives'}
    relations=db.execute("""SELECT n.nspname,c.relname,array_agg(a.attname::text ORDER BY a.attnum)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE c.relkind='r' AND n.nspname LIKE 'orbita\\_%' ESCAPE '\\'
        AND a.attnum>0 AND NOT a.attisdropped GROUP BY n.nspname,c.relname ORDER BY n.nspname,c.relname""").fetchall()
    result=[]
    for schema,table,columns in relations:
        if schema=='orbita_private' and table in omit:continue
        # A family can have an ordinary column named workspace_id: its private
        # _store_id always defines ownership, ahead of application columns.
        field=next((f for f in ('_store_id','workspace_id','store_id') if f in columns),None)
        if field is None:continue
        if field=='workspace_id':predicate=sql.SQL('{}=ANY(%s::uuid[])').format(sql.Identifier(field))
        else:predicate=sql.SQL('{} IN (SELECT id FROM orbita_private.stores WHERE workspace_id=ANY(%s::uuid[]))').format(sql.Identifier(field))
        statement=sql.SQL("SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS digest FROM {}.{} t WHERE {} ORDER BY digest").format(sql.Identifier(schema),sql.Identifier(table),predicate)
        digest=hashlib.sha256();count=0
        with db.cursor(name='manifest_'+uuid.uuid4().hex) as cursor:
            cursor.execute(statement,(ids,))
            for row in cursor:
                digest.update(row[0].encode('ascii')+b'\n');count+=1
                require(count<=2000000,'MIGRATION_ROW_LIMIT')
        result.append(dict(table=schema+'.'+table,rows=count,sha256=digest.hexdigest()))
    return dict(version=1,workspaceIds=ids,tables=result)


def stage_manifest(parameters,*,instance_id,control,children):
    """Capture after independent readback and owned consumers have closed."""
    ids=_ids(control,children)
    with _operator(parameters,instance_id) as db,db.transaction():
        _locks(db,ids);_stages(db,ids,frozen=False);_no_consumers(db,ids)
        return _manifest(db,ids)


def freeze_stages(parameters,*,instance_id,control,children):
    """Commit denial first. A live consumer leaves stages frozen and is reported.

    No process is killed. Close only owned consumers and explicitly repeat the
    check. Even a failed publication leaves the already committed freeze intact.
    """
    ids=_ids(control,children)
    with _operator(parameters,instance_id) as db:
        with db.transaction():
            _locks(db,ids);_stages(db,ids,frozen=False)
            db.execute('UPDATE orbita_private.workspaces SET active=false WHERE id=ANY(%s::uuid[])',(ids,))
        with db.transaction():
            _locks(db,ids);_stages(db,ids,frozen=True);_no_consumers(db,ids)
    return dict(status='FROZEN',workspaceIds=ids)


def publication_receipt(parameters,*,instance_id,operation_id):
    with _operator(parameters,instance_id) as db:
        row=db.execute('SELECT request_sha256,receipt FROM orbita_private.managed_publications WHERE operation_id=%s',(_uuid(operation_id),)).fetchone()
        return None if row is None else dict(requestSha256=row[0],receipt=row[1])


def import_access_snapshot(parameters,source,source_sha256,destination,*,config,limits=None):
    """Import one coherent legacy control to a private, unpublished stage.

    This operator-only entrypoint is separate from the ordinary importer, which
    still rejects access/lease families. The caller retains original DB/WAL/SHM
    custody and supplies the verified coherent snapshot hash. No retry or
    overwrite is implicit if the commit outcome is unknown.
    """
    from contextlib import closing
    from .config import binding_for
    from .connection import Connection
    from .leases import StoreLease
    from .legacy_sqlite import NativeReadHold,SqliteTransfer,installed_structure
    from .manifests import Limits
    from .transfers import import_stream
    binding,key=binding_for(destination,config)
    require(key=='access.pgstore','MIGRATION_ACCESS_LOCATOR')
    limits=limits or Limits()
    with _operator(parameters,config.instance_id) as db,db.transaction():
        # Hold publication out while admitting the runtime import connections.
        db.execute("SELECT pg_advisory_xact_lock_shared(hashtextextended('managed-admission:'||%s,0))",(binding.workspace_id,))
        require(db.execute('SELECT kind,parent_id,active FROM orbita_private.workspaces WHERE id=%s',(binding.workspace_id,)).fetchone()==('personal',None,True),'MIGRATION_STAGE_REQUIRED')
        require(not db.execute('SELECT 1 FROM orbita_private.stores WHERE workspace_id=%s LIMIT 1',(binding.workspace_id,)).fetchone(),'MIGRATION_ACCESS_ALREADY_PRESENT')
        with NativeReadHold(source,source_sha256,max_bytes=128*1024**2) as held,StoreLease(destination,config=config,mode='exclusive'):
            structure=installed_structure(destination,'access',config)
            with SqliteTransfer(source,source_sha256,family='access',structure=structure,limits=limits) as stream:
                require(set(stream.tables)=={'users','sessions','workspaces','members','audit','attempts','archives','plans'},'MIGRATION_ACCESS_TABLES')
                result=import_stream(stream,stream.size,destination,config=config,limits=limits)
                require(result==stream.info,'MIGRATION_ACCESS_IMPORT_MISMATCH')
                with closing(Connection(destination,family='access',config=config,read_only=True)) as reader:
                    require(reader.logical_manifest(limits=limits)==stream.manifest,'MIGRATION_ACCESS_FRESH_READBACK')
                    store_id=reader.session.store_id
                held.verify()
    return dict(status='IMPORTED_UNPUBLISHED_ACCESS',workspaceId=binding.workspace_id,storeId=store_id,sourceSha256=source_sha256,result=result,authorityPublished=False)


def publish_domain(parameters,*,instance_id,operation_id,control,control_store,children,manifest):
    ids=_ids(control,children);_uuid(control_store);_uuid(operation_id)
    request=dict(instanceId=instance_id,operationId=operation_id,control=control,controlStore=control_store,children=children,manifest=manifest)
    request_hash=_hash(request)
    with _operator(parameters,instance_id) as db,db.transaction():
        # One operation ID has exactly one request, including after a lost reply.
        db.execute("SELECT pg_advisory_xact_lock(hashtextextended('managed-publication:'||%s,0))",(operation_id,))
        prior=db.execute('SELECT request_sha256,receipt FROM orbita_private.managed_publications WHERE operation_id=%s',(operation_id,)).fetchone()
        if prior:
            require(prior[0]==request_hash,'MIGRATION_OPERATION_CHANGED');return prior[1]
        _locks(db,ids);_stages(db,ids,frozen=True);_no_consumers(db,ids)
        require(_manifest(db,ids)==manifest,'MIGRATION_MANIFEST_CHANGED')
        require(db.execute('SELECT id::text,family FROM orbita_private.stores WHERE workspace_id=%s ORDER BY id',(control,)).fetchall()==[(control_store,'access')],'MIGRATION_CONTROL_STORE')
        require(not db.execute("SELECT 1 FROM orbita_private.stores WHERE workspace_id=ANY(%s::uuid[]) AND family IN ('access','lease') LIMIT 1",(list(children.values()),)).fetchone(),'MIGRATION_CHILD_CONTROL')
        rows=db.execute('SELECT id,revision,payload FROM orbita_access.workspaces WHERE _store_id=%s ORDER BY id',(control_store,)).fetchall()
        require([r[0] for r in rows]==sorted(children),'MIGRATION_LOCAL_COVERAGE')
        policies=[]
        for local,revision,payload in rows:
            body=json.loads(payload);wid=children[local]
            require(body.get('id')==local and type(body.get('revision')) is int and body['revision']==revision,'MIGRATION_CONTROL_REVISION')
            status,rights,retain=db.execute('SELECT * FROM orbita_private.managed_policy(%s::jsonb)',(payload,)).fetchone()
            # Account erasure legitimately removes memberships after a purge.
            # A preserved tombstone grants no authority and cannot be revived.
            if status!='purged':
                require(db.execute('SELECT 1 FROM orbita_access.members m JOIN orbita_access.users u ON u._store_id=m._store_id AND u.id=m."user" WHERE m._store_id=%s AND m.workspace=%s AND m."user"=%s AND m.role=\'owner\'',(control_store,local,body.get('owner'))).fetchone() is not None,'MIGRATION_OWNER_IDENTITY')
            purge=body.get('purge') if status=='purged' else None
            if status=='purged':
                require(isinstance(purge,dict) and purge.get('workspace')==local and purge.get('managedFilesAbsent') is True and purge.get('scope')=='managed_workspace_only','MIGRATION_PURGE_RECEIPT')
                require(not db.execute("SELECT 1 FROM orbita_common.entries WHERE workspace_id=%s AND path<>'' UNION ALL SELECT 1 FROM orbita_common.objects WHERE workspace_id=%s UNION ALL SELECT 1 FROM orbita_common.chunk_blobs WHERE workspace_id=%s UNION ALL SELECT 1 FROM orbita_private.stores WHERE workspace_id=%s LIMIT 1",(wid,wid,wid,wid)).fetchone(),'MIGRATION_PURGED_CONTENT')
            else:require(purge is None and 'purge' not in body,'MIGRATION_PURGE_STATE')
            policies.append((local,wid,status,rights,retain,purge))
        archives=[]
        for archive,local,payload in db.execute('SELECT id,workspace,payload FROM orbita_access.archives WHERE _store_id=%s ORDER BY id',(control_store,)):
            _uuid(archive);body=json.loads(payload)
            require(local in children and body.get('id')==archive and body.get('workspace')==local,'MIGRATION_ARCHIVE_IDENTITY')
            require(isinstance(body.get('archive'),str) and bool(body['archive']),'MIGRATION_ARCHIVE_PATH')
            key='backups/'+archive+'.orbita'
            obj=db.execute("SELECT o.sha256,o.complete FROM orbita_common.entries e JOIN orbita_common.objects o ON o.workspace_id=e.workspace_id AND o.id=e.object_id WHERE e.workspace_id=%s AND e.path=%s AND e.kind='file'",(children[local],key)).fetchone()
            require(obj is not None and obj[1] and obj[0]==body.get('sha256'),'MIGRATION_ARCHIVE_CIPHERTEXT')
            archives.append((archive,local,hashlib.sha256(payload.encode('utf8')).hexdigest(),obj[0],key))
        secret=secrets.token_urlsafe(32)
        db.execute("UPDATE orbita_private.workspaces SET kind='control',active=true,capability_secret=%s,capability_hash=sha256(convert_to(%s,'UTF8')) WHERE id=%s",(secret,secret,control))
        for local,wid,status,rights,retain,purge in policies:
            worker=secrets.token_urlsafe(32);maintenance=secrets.token_urlsafe(32)
            db.execute("UPDATE orbita_private.workspaces SET kind='managed',parent_id=%s,active=%s,capability_secret=%s,capability_hash=sha256(convert_to(%s,'UTF8')) WHERE id=%s",(control,purge is None,worker,worker,wid))
            db.execute('INSERT INTO orbita_private.managed_workspaces(control_store_id,local_id,workspace_id,epoch,maintenance_secret,maintenance_hash,status,rights_until,retain_until,purge_receipt) VALUES(%s,%s,%s,1,%s,sha256(convert_to(%s,\'UTF8\')),%s,%s,%s,%s::jsonb)',(control_store,local,wid,maintenance,maintenance,status,rights,retain,json.dumps(purge) if purge else None))
        for archive,local,payload_hash,cipher_hash,key in archives:
            db.execute('INSERT INTO orbita_private.managed_legacy_archives VALUES(%s,%s,%s,%s,%s,%s)',(control_store,archive,local,payload_hash,cipher_hash,key))
        receipt=dict(status='PUBLISHED',operationId=operation_id,instanceId=instance_id,controlWorkspaceId=control,controlStoreId=control_store,children=children,manifestSha256=_hash(manifest),archiveBindings=len(archives),originalControlRowsUnchanged=True,automaticWork=False,externalAccess=False)
        db.execute('INSERT INTO orbita_private.managed_publications VALUES(%s,%s,%s,%s::jsonb)',(operation_id,request_hash,control,json.dumps(receipt)))
        return receipt
