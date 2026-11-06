"""Explicit migration of a completed v1 volume and its verified Parquet cut.

The exact imported relational source is retained. Two derived stores and their
receipt commit together. On resume the deterministic derivation is rebuilt in
a rolled-back transaction and compared to the saved stores; a saved receipt
alone is never an integrity oracle. No source file or original store is edited.
"""
from contextlib import closing
import hashlib,json,re,time,uuid
from pathlib import Path

from .config import require
from .connection import Connection,Row
from .objects import ObjectStore

MAX_BATCH=8*1024**2
canonical=lambda v:json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)
digest=lambda v:hashlib.sha256(v if isinstance(v,bytes) else v.encode('utf8')).hexdigest()


def check_volume(d,entries):
    require(set(d)=={'kind','store','cases','parquet'},'LEGACY_VOLUME_FIELDS')
    def entry(i):
        require(type(i) is int and 0<=i<len(entries),'LEGACY_VOLUME_INDEX')
        return entries[i]
    source=entry(d['store'])
    require(source['kind']=='store' and source['family']=='volume' and source['source']=='volume/operational.sqlite' and source['target']=='volume/legacy-source.pgstore','LEGACY_VOLUME_SOURCE')
    for name in ('cases','parquet'):
        values=d[name];require(isinstance(values,list) and len(values)<=20000 and all(type(i) is int for i in values) and len(set(values))==len(values),'LEGACY_VOLUME_MAPPING')
        for i in values:entry(i)
    require(bool(d['cases']),'LEGACY_VOLUME_CASE_MAPPING')
    for i in d['parquet']:
        e=entry(i)
        require(e['kind']=='custody' and re.fullmatch(r'volume/lake/[^/]+\.parquet',e['source']) is not None,'LEGACY_VOLUME_PARQUET_MAPPING')
    require(set(d['parquet'])=={i for i,e in enumerate(entries) if e['source'].startswith('volume/lake/')},'LEGACY_VOLUME_UNCLASSIFIED_PARQUET')
    for target in ('volume/operational.pgstore','volume/analytical.pgstore','volume/migration.json'):
        folded=target.casefold()
        require(not any(e['target'].casefold()==folded or e['target'].casefold().startswith(folded+'/') or folded.startswith(e['target'].casefold()+'/') for e in entries),'LEGACY_VOLUME_TARGET_COLLISION')


def materialize_volume(d,plan,receipts,files,payload,config,binding,manifests,*,progress):
    entries=plan['entries'];source=receipts[d['store']];source_key=payload+'/'+entries[d['store']]['target']
    paths=dict(operational=payload+'/volume/operational.pgstore',analytical=payload+'/volume/analytical.pgstore')
    receipt_key=payload+'/volume/migration.json';started=time.monotonic()
    def deadline():require(time.monotonic()-started<120,'LEGACY_VOLUME_DEADLINE')
    members={entries[i]['source']:receipts[i] for i in d['parquet']};used=set();proofs=[]
    def parquet(name,expected_hash,expected_bytes,columns,max_rows):
        deadline();require(name in members and name not in used,'LEGACY_VOLUME_PARQUET_MAPPING');used.add(name)
        r=members[name];key=payload+'/'+r['custodyPath'];stat=files.stat(key)
        require(r['sourceSha256']==expected_hash and stat['size']<=64*1024**2 and (expected_bytes is None or stat['size']==expected_bytes),'LEGACY_VOLUME_PARQUET_HASH')
        with files.open_read(key) as stream:
            h=hashlib.sha256()
            while chunk:=stream.read(1024**2):h.update(chunk);deadline()
            require(h.hexdigest()==expected_hash,'LEGACY_VOLUME_PARQUET_HASH');stream.seek(0)
            import pyarrow.parquet as pq
            reader=pq.ParquetFile(stream)
            require(reader.schema_arrow.names==columns and reader.metadata.num_rows<=max_rows,'LEGACY_VOLUME_PARQUET_SCHEMA')
            size=sum(reader.metadata.row_group(i).total_byte_size for i in range(reader.metadata.num_row_groups))
            require(size<=16*1024**2,'LEGACY_VOLUME_PARQUET_BUDGET')
            rows=reader.read(use_threads=False).to_pylist()
        proofs.append(dict(source=name,sha256=expected_hash,rows=len(rows)));return rows
    with closing(Connection(Path(binding.root)/source_key,family='volume',config=config,read_only=True)) as db:
        db.row_factory=Row;db.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        require(db.logical_manifest()==source['result']['manifest'],'LEGACY_VOLUME_SOURCE_CHANGED')
        meta=dict(tuple(r) for r in db.execute('SELECT k,v FROM meta'))
        require(meta.get('schema')=='1' and re.fullmatch('[0-9a-f]{64}',meta.get('secret','')) is not None,'LEGACY_VOLUME_FORMAT')
        for field in ('instance','generation'):
            require(str(uuid.UUID(meta[field]))==meta[field],'LEGACY_VOLUME_IDENTITY')
        require(len(meta.get('catalog','').encode())<=MAX_BATCH,'LEGACY_VOLUME_CATALOG_BUDGET')
        catalog=json.loads(meta['catalog']);require(canonical(catalog)==meta['catalog'] and digest(meta['catalog'])==meta.get('token'),'LEGACY_VOLUME_CATALOG_HASH')
        mapped={Path(entries[i]['target']).parent.name:(i,manifests[i]) for i in d['cases']}
        require(len(catalog)<=10000 and len({s['id'] for s in catalog})==len(catalog),'LEGACY_VOLUME_CATALOG')
        for s in catalog:
            require(s['id'] in mapped,'LEGACY_VOLUME_CASE_MAPPING');index,case=mapped[s['id']]
            require(s['caseHash']==case['caseHash'] and s['manifestHash']==receipts[index]['sourceSha256'],'LEGACY_VOLUME_CASE_BINDING')
            row=db.execute('SELECT case_hash,manifest_hash,complete,records FROM sources WHERE id=?',(s['id'],)).fetchone()
            require(row is not None and row[0]==s['caseHash'] and row[1]==s['manifestHash'] and row[2]==1,'LEGACY_VOLUME_SOURCE_PENDING')
            require(row[3]==db.execute('SELECT COUNT(*) FROM records WHERE source_id=?',(s['id'],)).fetchone()[0],'LEGACY_VOLUME_SOURCE_COUNT')
        high=db.execute('SELECT COALESCE(MAX(seq),0) FROM records').fetchone()[0]
        require(db.execute('SELECT COUNT(*) FROM records').fetchone()[0]==high and int(meta['lake_cursor'])==high,'LEGACY_VOLUME_CUT_PENDING')
        heads=[dict(r) for r in db.execute('SELECT * FROM heads LIMIT 2')]
        require(len(heads)==1 and heads[0]['gen']==meta['generation'] and heads[0]['token']==meta['token'] and heads[0]['cut']==high,'LEGACY_VOLUME_HEAD_REQUIRES_CLASSIFICATION')
        head=heads[0];parts=[dict(r) for r in db.execute('SELECT * FROM parts ORDER BY lo LIMIT 20001')]
        require(len(parts)<=20000,'LEGACY_VOLUME_PART_BUDGET');cursor=0;derived_parts=[]
        for part in parts:
            deadline();require(part['lo']==cursor+1 and part['hi']-cursor==part['n'] and 1<=part['n']<=500 and part['hi']<=high,'LEGACY_VOLUME_PART_GAP')
            require(re.fullmatch(r'[^/\\]+\.parquet',part['path']) is not None,'LEGACY_VOLUME_PARQUET_PATH')
            rows=[dict(r) for r in db.execute('SELECT seq,source_id,uri,kind,raw,payload,row_hash FROM records WHERE seq>=? AND seq<=? ORDER BY seq',(part['lo'],part['hi']))]
            require(len(rows)==part['n'] and sum(len(r['payload'].encode()) for r in rows)<=MAX_BATCH,'LEGACY_VOLUME_ROW_BUDGET')
            for i,r in enumerate(rows):
                value=json.loads(r['payload'])
                require(r['seq']==cursor+i+1 and digest(r['payload'])==r['row_hash'] and canonical(value)==r['payload'],'LEGACY_VOLUME_ROW_HASH')
                require(value['raw']==r['raw'] and digest(value['raw'])==value['sha'] and value['sourceId']==r['source_id'] and value['uri']==r['uri'] and value['kind']==r['kind'],'LEGACY_VOLUME_RAW_BINDING')
            expected=[{k:r[k] for k in ('seq','source_id','kind','payload','row_hash')} for r in rows]
            require(parquet('volume/lake/'+part['path'],part['sha'],part['bytes'],list(expected[0]),500)==expected,'LEGACY_VOLUME_PARQUET_ROWS')
            derived_parts.append(dict(lo=part['lo'],hi=part['hi'],n=part['n'],path='rows/'+str(part['lo'])+'-'+str(part['hi']),sha=digest(canonical(rows)),bytes=sum(len(r['payload'].encode()) for r in rows)))
            cursor=part['hi']
        require(cursor==high,'LEGACY_VOLUME_INCOMPLETE')
        expected=[dict(source_id=s['id'],metadata=canonical(s),generation=meta['generation'],catalog_token=meta['token'],cut=high) for s in catalog]
        if not expected:expected=[dict(source_id='',metadata='null',generation=meta['generation'],catalog_token=meta['token'],cut=high)]
        require(re.fullmatch(r'[^/\\]+\.parquet',head['path']) is not None,'LEGACY_VOLUME_PARQUET_PATH')
        require(head['n']==len(expected) and parquet('volume/lake/'+head['path'],head['sha'],None,list(expected[0]),10000)==expected,'LEGACY_VOLUME_PARQUET_CATALOG')
        require(used==set(members),'LEGACY_VOLUME_UNCLASSIFIED_PARQUET')
    existence=[files.exists(k) for k in [*paths.values(),receipt_key]]
    require(not any(existence) or all(existence),'LEGACY_VOLUME_PARTIAL_DERIVATION')
    resumed=all(existence)
    targets={k:payload+'/volume/check-'+str(uuid.uuid4())+'-'+k+'.pgstore' for k in paths} if resumed else paths
    with closing(Connection(Path(binding.root)/source_key,family='volume',config=config)) as db:
        db.begin_consistent_write()
        try:
            require(db.logical_manifest()==source['result']['manifest'],'LEGACY_VOLUME_SOURCE_CHANGED')
            derived={}
            for kind,key in targets.items():
                deadline();db.raw.execute('SELECT orbita_common.clone_tree(%s,%s)',(source_key,key))
                db.session.open_store(key,'volume')
                db.execute("UPDATE meta SET v='2' WHERE k='schema'")
                changes=({'legacy_cursor_format':'orbita-volume-1'} if kind=='operational' else {'cursor':str(high),'catalog:'+meta['generation']:meta['catalog']})
                for k,v in changes.items():db.execute('INSERT INTO meta VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v',(k,v))
                if kind=='analytical':
                    for part in derived_parts:
                        db.execute('UPDATE parts SET path=?,sha=?,bytes=? WHERE lo=?',(part['path'],part['sha'],part['bytes'],part['lo']))
                    db.execute('UPDATE heads SET path=?,sha=?,n=? WHERE gen=?',('catalog:'+meta['generation'],digest(meta['catalog']),max(1,len(catalog)),meta['generation']))
                derived[kind]=db.logical_manifest()
            value=dict(schema='orbita-legacy-volume-1',sourceRowsSha256=source['result']['manifest']['sha256'],sourceSha256=source['sourceSha256'],instance=meta['instance'],generation=meta['generation'],catalogToken=meta['token'],cut=high,parquet=proofs,stores=derived,legacyCursorFormat='orbita-volume-1',sourceRetained='volume/legacy-source.pgstore')
            raw=(canonical(value)+'\n').encode('utf8')
            if resumed:db.rollback()
            else:
                objects=ObjectStore.borrow(db)
                try:objects.write_bytes(receipt_key,raw,exclusive=True)
                finally:objects.close()
                progress(dict(event='volume-before-commit'));db.commit()
        except BaseException:
            if db.in_transaction:db.rollback()
            raise
    require(files.read_bytes(receipt_key)==raw,'LEGACY_VOLUME_RESUME_RECEIPT_MISMATCH')
    for kind,key in paths.items():
        with closing(Connection(Path(binding.root)/key,family='volume',config=config,read_only=True)) as reader:
            require(reader.logical_manifest()==derived[kind],'LEGACY_VOLUME_DERIVED_MISMATCH')
    deadline();progress(dict(event='volume-derived-verified'))
    return dict(kind='volume',target='volume/migration.json',sha256=digest(raw),bytes=len(raw),sourceSha256=source['sourceSha256'],cut=high,stores={k:v['sha256'] for k,v in derived.items()})
