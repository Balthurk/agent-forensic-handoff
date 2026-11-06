"""Observe owned runtime transports; tags never confer database authority."""
import os
import uuid
import psycopg
from . import SCHEMA_VERSION
from .config import require


def owner_name(value=None):
    value=os.environ.get('ORBITA_POSTGRES_OWNER_ID') if value is None else value
    if value is None:return 'orbita-common-store'
    try:canonical=str(uuid.UUID(value))
    except (ValueError,TypeError,AttributeError):
        require(False,'PROCESS_OWNER_ID')
    require(value==canonical,'PROCESS_OWNER_ID')
    return 'orbita-owned-'+canonical


def observe_owner(config,owner):
    name=owner_name(owner)
    require(name!='orbita-common-store','PROCESS_OWNER_ID')
    # A fresh independent read also works after the child's authority is
    # revoked. It exposes counts only, and cannot authorize or terminate it.
    with psycopg.connect(**config.connection_parameters(),connect_timeout=5,
                        autocommit=True,application_name='orbita-owner-observer') as db:
        db.execute("SET statement_timeout='3s'; SET default_transaction_read_only=on")
        identity=db.execute('SELECT instance_id::text,version,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb '
                            'FROM orbita_common.identity CROSS JOIN pg_roles WHERE rolname=current_user').fetchall()
        require(identity==[(config.instance_id,SCHEMA_VERSION,False,False,False,False)],'INSTANCE_MISMATCH')
        db.execute('SELECT pg_stat_clear_snapshot()')
        count=db.execute('SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() '
                         'AND usename=current_user AND application_name=%s',(name,)).fetchone()[0]
    return dict(ownerId=owner,backends=count)
