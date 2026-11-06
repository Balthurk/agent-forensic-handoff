"""Operator-only installation/provisioning. Never imported by runtime workers."""
from pathlib import Path
import hashlib
import secrets
import uuid

import psycopg
from psycopg import sql

from . import SCHEMA_VERSION, StoreError
from .config import require


def connect_operator(parameters):
    require(parameters.get('host') in ('127.0.0.1','::1','localhost'), 'LOOPBACK_REQUIRED')
    require(parameters.get('user') != 'orbita_runtime', 'OPERATOR_ROLE_REQUIRED')
    return psycopg.connect(**{k:parameters[k] for k in ('host','port','dbname','user','password')}, connect_timeout=5, autocommit=True, application_name='orbita-common-install')


def install(parameters, *, instance_id, runtime_password):
    from .installation import schema_bundle,install_complete
    instance_id=str(uuid.UUID(instance_id))
    require(isinstance(runtime_password,str) and len(runtime_password)>=32,'RUNTIME_PASSWORD')
    bundle,package=schema_bundle()
    with connect_operator(parameters) as db:
        db.execute("SET lock_timeout='10s'")
        db.execute("SET statement_timeout='60s'")
        require(db.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'").fetchone()[0]==0,'INSTALL_CLIENTS_ACTIVE')
        with db.transaction():
            db.execute("SELECT pg_advisory_xact_lock(hashtextextended('orbita-complete-install',0))")
            current=db.execute("SELECT to_regclass('orbita_common.identity')").fetchone()[0]
            if current:
                require(db.execute('SELECT instance_id::text,version FROM orbita_common.identity').fetchall()==[(instance_id,SCHEMA_VERSION)],'INSTANCE_ALREADY_INITIALIZED')
                # Existing credentials are checked, never silently rotated.
                runtime={k:parameters[k] for k in ('host','port','dbname')}
                with psycopg.connect(**runtime,user='orbita_runtime',password=runtime_password,connect_timeout=5) as check:
                    require(check.execute('SELECT instance_id::text FROM orbita_common.identity').fetchone()[0]==instance_id,'INSTANCE_MISMATCH')
            else:
                require(db.execute("SELECT 1 FROM pg_roles WHERE rolname='orbita_runtime'").fetchone() is None,'RUNTIME_ROLE_ALREADY_EXISTS')
                db.execute(sql.SQL('CREATE ROLE orbita_runtime LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS').format(sql.Literal(runtime_password)))
                db.execute(sql.SQL('REVOKE ALL ON DATABASE {} FROM PUBLIC').format(sql.Identifier(parameters['dbname'])))
                db.execute(sql.SQL('GRANT CONNECT ON DATABASE {} TO orbita_runtime').format(sql.Identifier(parameters['dbname'])))
                db.execute((Path(__file__).parent/'bootstrap.sql').read_text(encoding='utf8'))
                db.execute('INSERT INTO orbita_common.identity(instance_id,version) VALUES(%s,%s)',(instance_id,SCHEMA_VERSION))
            db.execute(Path(__file__).with_name('authority.sql').read_text(encoding='utf8'))
            install_object_protocol(db)
            complete=install_complete(db,bundle,package)
            require(db.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'").fetchone()[0]==0,'INSTALL_CLIENTS_BECAME_ACTIVE')
        return dict(status='ALREADY_INITIALIZED' if current else 'INITIALIZED',instanceId=instance_id,version=SCHEMA_VERSION,database=parameters['dbname'],complete=complete)


def provision_workspace(parameters, *, label, kind='personal', workspace_id=None, parent_id=None):
    require(kind in ('personal','managed','control','test'),'WORKSPACE_KIND')
    require(isinstance(label,str) and 0<len(label)<=200,'WORKSPACE_LABEL')
    workspace_id=str(uuid.UUID(workspace_id)) if workspace_id else str(uuid.uuid4())
    capability=secrets.token_urlsafe(32)
    with connect_operator(parameters) as db:
        db.execute('INSERT INTO orbita_private.workspaces(id,label,kind,parent_id,capability_hash,capability_secret) VALUES(%s,%s,%s,%s,%s,%s)',(workspace_id,label,kind,parent_id,hashlib.sha256(capability.encode()).digest(),capability))
    # This return contains a credential; persist only in the protected operator
    # configuration. Receipts use workspace_id and must not serialize this dict.
    return {'workspaceId':workspace_id,'capability':capability}


def install_object_protocol(db):
    with db.transaction():
        db.execute(Path(__file__).with_name('objects.sql').read_text(encoding='utf8'))
        db.execute(Path(__file__).with_name('names.sql').read_text(encoding='utf8'))
        db.execute(Path(__file__).with_name('definitions.sql').read_text(encoding='utf8'))
        db.execute(Path(__file__).with_name('trees.sql').read_text(encoding='utf8'))
        db.execute(Path(__file__).with_name('manifests.sql').read_text(encoding='utf8'))
        db.execute(Path(__file__).with_name('leases.sql').read_text(encoding='utf8'))
        db.execute(Path(__file__).with_name('transfers.sql').read_text(encoding='utf8'))
        db.execute(Path(__file__).with_name('restore_control.sql').read_text(encoding='utf8'))


def install_managed_protocol(db):
    """Requires the actual access tables; shared by fresh builds and upgrades."""
    with db.transaction():
        require(db.execute("SELECT to_regclass('orbita_access.workspaces')").fetchone()[0] is not None,
                'ACCESS_FAMILY_REQUIRED')
        db.execute(Path(__file__).with_name('authority.sql').read_text(encoding='utf8'))
        db.execute(Path(__file__).with_name('managed.sql').read_text(encoding='utf8'))
        db.execute(Path(__file__).with_name('managed_migration.sql').read_text(encoding='utf8'))
