"""Request-local read batching. Original validators remain the only authority.

This cache is usable only in the same PostgreSQL REPEATABLE READ transaction.
It contains database evidence, never approval, source permission or validity.
"""
import json


class BufferedCursor:
    def __init__(self, rows, row_type):
        self.rows = [row_type(r) for r in rows]
        self.position = 0
        self.rowcount = len(rows)
    def fetchone(self):
        if self.position >= len(self.rows):return None
        row = self.rows[self.position];self.position += 1
        return type(row)(row)
    def fetchall(self):return list(self)
    def fetchmany(self, size=1000):
        result=[]
        while len(result)<size:
            row=self.fetchone()
            if row is None:break
            result.append(row)
        return result
    def __iter__(self):
        while (row := self.fetchone()) is not None:yield row


def unique(rows, key, columns):
    result={}
    for row in rows:
        value=dict(zip(columns,row));identity=value[key]
        if identity in result:raise ValueError('SEMANTIC_PG_BATCH_NON_UNIQUE')
        result[identity]=value
    return result


class IntegrityBatch:
    @classmethod
    def build(cls, connection, rows):
        if not connection.read_only or int(connection.raw.info.transaction_status)!=2 or not 1<=len(rows)<=5000:return None
        scopes={r['scope'] for r in rows}
        if len(scopes)!=1:return None
        scope=next(iter(scopes));acts=set();clauses=set();versions=set();entries=0
        for row in rows:
            payload=json.loads(row['payload'])
            if not isinstance(payload,dict):return None
            unit=payload.get('semantic_unit')
            if not isinstance(unit,dict) or unit.get('schema_version')!='noetis.semantic-act.v1':continue
            if not isinstance(unit.get('act_id'),str):return None
            acts.add(unit['act_id'])
            manifest=unit.get('manifest')
            if not isinstance(manifest,dict) or not isinstance(manifest.get('entries'),list):return None
            for item in manifest['entries']:
                entries+=1
                if entries>5000 or not isinstance(item,dict) or not isinstance(item.get('semantic_clause_id'),str) or not isinstance(item.get('clause_version_id'),str):return None
                clauses.add(item['semantic_clause_id']);versions.add(item['clause_version_id'])
        required={'record_envelopes','record_integrity_policy','semantic_act_identity','semantic_clause_identity','semantic_clause_versions'}
        tables={r[0] for r in connection.raw.execute("SELECT name FROM orbita_ddl WHERE type='table' AND name=ANY(%s)",(sorted(required|{'semantic_support_admissions'}),))}
        if not required.issubset(tables):return None
        value=cls();value.scope=scope;value.rowids={r['_rowid'] for r in rows};value.records={r['record_id'] for r in rows};value.acts=acts;value.clauses=clauses;value.versions=versions
        raw=connection.raw
        value.envelopes=unique(raw.execute('SELECT record_rowid,digest_version,digest FROM record_envelopes WHERE record_rowid=ANY(%s)',(sorted(value.rowids),)),'record_rowid',['record_rowid','digest_version','digest'])
        value.policy=[{'legacy_max_rowid':r[0]} for r in raw.execute('SELECT legacy_max_rowid FROM record_integrity_policy WHERE singleton=1')]
        value.act_map=unique(raw.execute('SELECT act_id,record_id FROM semantic_act_identity WHERE scope=%s AND act_id=ANY(%s)',(scope,sorted(acts))),'act_id',['act_id','record_id'])
        value.clause_map=unique(raw.execute('SELECT semantic_clause_id,act_id,record_id FROM semantic_clause_identity WHERE scope=%s AND semantic_clause_id=ANY(%s)',(scope,sorted(clauses))),'semantic_clause_id',['semantic_clause_id','act_id','record_id'])
        value.version_map=unique(raw.execute('SELECT clause_version_id,semantic_clause_id,clause_sha256 FROM semantic_clause_versions WHERE scope=%s AND clause_version_id=ANY(%s)',(scope,sorted(versions))),'clause_version_id',['clause_version_id','semantic_clause_id','clause_sha256'])
        value.support_table='semantic_support_admissions' in tables
        # Fetch only the bounded set of IDs with committed admissions. For those
        # IDs, read and validate every original receipt through the normal path.
        # Never cache an unbounded set of potentially large admission packets.
        value.admitted={r[0] for r in raw.execute('SELECT DISTINCT record_id FROM semantic_support_admissions WHERE record_id=ANY(%s)',(sorted(value.records),))} if value.support_table else set()
        return value

    @staticmethod
    def selected(value, fields):return [{k:value[k] for k in fields}] if value is not None else []

    def lookup(self, statement, parameters):
        parameters=tuple(parameters or ())
        if statement=='SELECT legacy_max_rowid FROM record_integrity_policy WHERE singleton=1' and not parameters:return self.policy
        if statement=="SELECT 1 FROM sqlite_master WHERE name='semantic_support_admissions'" and not parameters:return [{'?column?':1}] if self.support_table else []
        if statement in ('SELECT * FROM record_envelopes WHERE record_rowid=?','SELECT digest FROM record_envelopes WHERE record_rowid=?') and len(parameters)==1 and isinstance(parameters[0],int) and parameters[0] in self.rowids:
            value=self.envelopes.get(parameters[0])
            if statement=='SELECT * FROM record_envelopes WHERE record_rowid=?':return self.selected(value,['record_rowid','digest_version','digest'])
            if statement=='SELECT digest FROM record_envelopes WHERE record_rowid=?':return self.selected(value,['digest'])
        if statement=='SELECT * FROM semantic_support_admissions WHERE record_id=? ORDER BY version DESC' and len(parameters)==1 and isinstance(parameters[0],str) and parameters[0] in self.records and parameters[0] not in self.admitted:return []
        if len(parameters)!=2 or parameters[0]!=self.scope or not isinstance(parameters[1],str):return None
        key=parameters[1]
        if statement=='SELECT record_id FROM semantic_act_identity WHERE scope=? AND act_id=?' and key in self.acts:return self.selected(self.act_map.get(key),['record_id'])
        if statement=='SELECT act_id,record_id FROM semantic_clause_identity WHERE scope=? AND semantic_clause_id=?' and key in self.clauses:return self.selected(self.clause_map.get(key),['act_id','record_id'])
        if statement=='SELECT semantic_clause_id,clause_sha256 FROM semantic_clause_versions WHERE scope=? AND clause_version_id=?' and key in self.versions:return self.selected(self.version_map.get(key),['semantic_clause_id','clause_sha256'])
        return None
