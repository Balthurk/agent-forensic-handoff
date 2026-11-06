"""Recoverable, identity-bound NOLOGIN barrier for an explicit operator backup.

Only ALTER ROLE changes LOGIN. Recovery compares the actual committed row's
xmin and the authenticated transaction epoch under catalogue locks. It never
terminates clients and never attributes a later administrator change to us.
"""
from pathlib import Path
import hmac
import json

from psycopg import sql

from .admin import connect_operator
from .config import require
from .legacy_sqlite import NativeReadHold
from .service_archive import durable_json, mac


def _role(db, key, name):
    row = db.execute("SELECT oid::text,xmin::text,rolcanlogin,to_jsonb(r)-'oid'-'rolcanlogin' FROM pg_authid r WHERE rolname=%s", (name,)).fetchone()
    require(row is not None, 'SERVICE_RUNTIME_ROLE_MISSING')
    memberships = db.execute("SELECT pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor),admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY 1,2,3").fetchall()
    return dict(oid=row[0], xmin=row[1], login=row[2], attributes=mac(key, row[3]), memberships=mac(key, memberships))


def _lock_catalogues(db):
    db.execute("SET LOCAL lock_timeout='2s'")
    db.execute('LOCK TABLE pg_catalog.pg_authid,pg_catalog.pg_auth_members IN SHARE ROW EXCLUSIVE MODE')


def _save(path, value, key, *, exclusive=False):
    durable_json(path, dict(payload=value, hmac=mac(key, value)), exclusive=exclusive)


def _load(path, key):
    with NativeReadHold(Path(path), max_bytes=65536) as held:
        envelope = json.loads(held.file.read())
        require(set(envelope) == {'payload', 'hmac'} and hmac.compare_digest(mac(key, envelope['payload']), envelope['hmac']), 'SERVICE_INTENT_AUTHENTICATION')
        value = envelope['payload']; require(value['schema'] == 2, 'SERVICE_INTENT_SCHEMA')
        return value


def _identity(db, instance_id):
    require(db.execute('SELECT instance_id::text FROM orbita_common.identity').fetchall() == [(instance_id,)], 'SERVICE_INSTANCE_CHANGED')


def _advisory(db, instance_id):
    require(db.execute("SELECT pg_try_advisory_lock(hashtextextended(%s,0))", ('orbita-service-maintenance:' + instance_id,)).fetchone()[0], 'SERVICE_MAINTENANCE_OWNER_LIVE')


def no_clients(db, *, allowed=()):
    db.execute('SELECT pg_stat_clear_snapshot()')
    rows = db.execute("SELECT pid FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid() AND NOT(pid=ANY(%s::int[]))", (list(allowed),)).fetchall()
    require(not rows, 'SERVICE_CLIENTS_ACTIVE')


def _restore(db, path, value, key, progress):
    require(value['role'] == 'orbita_runtime', 'SERVICE_RECOVERY_ROLE')
    original = value['original']
    with db.transaction():
        _lock_catalogues(db)
        current = _role(db, key, value['role'])
        require(all(current[k] == original[k] for k in ('oid', 'attributes', 'memberships')), 'SERVICE_ROLE_CHANGED_EXTERNALLY')
        now = int(db.execute('SELECT pg_current_xact_id()::text').fetchone()[0])
        def own_version(xid):
            return xid is not None and 0 <= now - int(xid) < 2**31 and current['xmin'] == str(int(xid) % 2**32)
        if current['login'] == original['login'] and (current['xmin'] == original['xmin'] or own_version(value.get('restoreXid8'))):
            outcome = 'ORIGINAL_AUTHORITY_ALREADY_PRESENT'
        else:
            require(original['login'] and current['login'] is False and own_version(value.get('mutationXid8')), 'SERVICE_ROLE_VERSION_NOT_OWNED')
            value['restoreXid8'] = str(now); value['state'] = 'RESTORE_INTENT_DURABLE'; _save(path, value, key)
            db.execute(sql.SQL('ALTER ROLE {} LOGIN').format(sql.Identifier(value['role'])))
            restored = _role(db, key, value['role'])
            require(restored['xmin'] == str(now % 2**32) and restored['login'] is True, 'SERVICE_RESTORE_VERSION')
            outcome = 'OWN_LOGIN_CHANGE_RESTORED'
    progress('after_restore_commit_before_receipt')
    value['state'] = 'RECOVERED'; value['outcome'] = outcome; _save(path, value, key)
    return dict(status=outcome, role=value['role'], instanceId=value['instanceId'], originalLogin=original['login'])


class Maintenance:
    def __init__(self, operator, *, instance_id, service, intent, key, backup_id, expected_role, progress=lambda event: None):
        self.operator=operator; self.instance_id=instance_id; self.service=service; self.intent=Path(intent); self.key=key
        self.backup_id=backup_id; self.expected_role=expected_role; self.progress=progress; self.db=None; self.value=None

    def __enter__(self):
        self.db=connect_operator(self.operator)
        try:
            self.db.execute("SET timezone='UTC'")
            _identity(self.db,self.instance_id); _advisory(self.db,self.instance_id); no_clients(self.db)
            with self.db.transaction():
                _lock_catalogues(self.db); original=_role(self.db,self.key,'orbita_runtime')
                require(original==self.expected_role,'SERVICE_ROLE_CHANGED_BEFORE_BARRIER')
                xid=self.db.execute('SELECT pg_current_xact_id()::text').fetchone()[0]
                self.value=dict(schema=2,backupId=self.backup_id,instanceId=self.instance_id,service=self.service,role='orbita_runtime',
                                original=original,mutationXid8=xid if original['login'] else None,restoreXid8=None,state='MUTATION_INTENT_DURABLE')
                _save(self.intent,self.value,self.key,exclusive=True); self.progress('after_intent_before_alter')
                if original['login']:
                    self.db.execute('ALTER ROLE orbita_runtime NOLOGIN')
                    current=_role(self.db,self.key,'orbita_runtime')
                    require(current['xmin']==str(int(xid)%2**32) and not current['login'],'SERVICE_MUTATION_VERSION')
                self.progress('after_alter_before_commit')
            self.progress('after_nologin_commit_before_receipt')
            self.value['state']='BARRIER_COMMITTED'; _save(self.intent,self.value,self.key)
            no_clients(self.db)
            return self
        except BaseException:
            try:
                self.db.rollback()
                if self.intent.exists(): _restore(self.db,self.intent,_load(self.intent,self.key),self.key,lambda event:None)
            finally:self.db.close()
            raise

    def verify_role(self):
        current=_role(self.db,self.key,'orbita_runtime'); original=self.value['original']
        require(all(current[k]==original[k] for k in ('oid','attributes','memberships')) and not current['login'],'SERVICE_BARRIER_CHANGED')
        expected=str(int(self.value['mutationXid8'])%2**32) if self.value['mutationXid8'] else original['xmin']
        require(current['xmin']==expected,'SERVICE_ROLE_VERSION_NOT_OWNED')

    def __exit__(self,*unused):
        try:
            self.db.rollback(); _identity(self.db,self.instance_id)
            self.recovery=_restore(self.db,self.intent,_load(self.intent,self.key),self.key,self.progress)
        finally:self.db.close()


def recover(operator, *, instance_id, service, intent, key, progress=lambda event:None):
    value=_load(intent,key)
    require(value['instanceId']==instance_id and value['service']==service,'SERVICE_RECOVERY_IDENTITY')
    with connect_operator(operator) as db:
        db.execute("SET timezone='UTC'")
        _identity(db,instance_id); _advisory(db,instance_id)
        return _restore(db,Path(intent),value,key,progress)
