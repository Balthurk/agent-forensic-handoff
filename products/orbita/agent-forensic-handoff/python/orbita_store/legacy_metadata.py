"""Declared metadata derivations for an explicit legacy import.

Sources remain opaque, byte-exact custody objects. Only a case/projection's
physical storage descriptor and a library item's declared path may change.
Derived objects are deterministic and compared in full on every resume.
"""
from contextlib import closing
import hashlib
import json
from pathlib import Path, PurePosixPath
import re

from .config import require
from .connection import Connection
from .legacy_sqlite import OLD_CHUNK_FIELDS

MAX_JSON=16*1024*1024


def checked_index(value,entries):
    require(type(value) is int and 0<=value<len(entries),'LEGACY_DERIVATION_INDEX')
    return entries[value]


def check_derivations(plan):
    entries=plan['entries'];derivations=plan['derivations']
    require(isinstance(derivations,list) and 0<len(derivations)<=10000,'LEGACY_DERIVATION_BUDGET')
    seen=set();cases={};volumes=set()
    for d in derivations:
        require(isinstance(d,dict) and d.get('kind') in ('case','projection','library','volume'),'LEGACY_DERIVATION_KIND')
        if d['kind']=='volume':
            from .legacy_volume import check_volume
            check_volume(d,entries)
            require(d['store'] not in volumes,'LEGACY_VOLUME_DUPLICATE');volumes.add(d['store'])
            continue
        kind=d['kind'];expected={'kind','entry','mappings'} if kind=='library' else {'kind','entry','store','caseHash'} | ({'case','projectionHash'} if kind=='projection' else set())
        require(set(d)==expected,'LEGACY_DERIVATION_FIELDS')
        entry=checked_index(d['entry'],entries)
        require(entry['kind']=='custody' and d['entry'] not in seen,'LEGACY_DERIVATION_SOURCE')
        seen.add(d['entry'])
        if kind=='library':
            require(entry['target']=='library.json' and isinstance(d['mappings'],list) and len(d['mappings'])<=10000,'LEGACY_LIBRARY_MAPPING')
            continue
        store=checked_index(d['store'],entries);folder=str(PurePosixPath(entry['target']).parent)
        expected_name='case' if kind=='case' else 'semantic'
        require(entry['target'].endswith('/'+('case.json' if kind=='case' else 'projection.json')) and folder!='.','LEGACY_METADATA_PATH')
        require(store['kind']=='store' and store['family']==('case' if kind=='case' else 'vector') and store['target']==folder+'/'+expected_name+'.pgstore','LEGACY_METADATA_STORE')
        require(re.fullmatch('[0-9a-f]{64}',d['caseHash']) is not None,'LEGACY_CASE_IDENTITY')
        if kind=='case':
            cases[d['entry']]=d
            # The immutable derived seal is never allowed to shadow a planned
            # source, including a case-insensitive alias or ancestor.
            prefix=(folder+'/case-seals').casefold()
            require(not any(e['target'].casefold()==prefix or e['target'].casefold().startswith(prefix+'/') or prefix.startswith(e['target'].casefold()+'/') for e in entries),'LEGACY_DERIVED_TARGET_COLLISION')
        else:require(re.fullmatch('[0-9a-f]{64}',d['projectionHash']) is not None,'LEGACY_PROJECTION_IDENTITY')
    for d in derivations:
        if d['kind']=='volume':
            require(all(i in cases for i in d['cases']),'LEGACY_VOLUME_CASE_MAPPING')
            continue
        if d['kind']=='projection':
            require(type(d['case']) is int and d['case'] in cases,'LEGACY_PROJECTION_CASE')
            case=cases[d['case']];folder=str(PurePosixPath(entries[d['case']]['target']).parent)
            require(d['caseHash']==case['caseHash'] and entries[d['entry']]['target'].startswith(folder+'/projections/'),'LEGACY_PROJECTION_CASE')
        if d['kind']=='library':
            ids=set();mapped=set()
            for m in d['mappings']:
                require(isinstance(m,dict) and set(m)=={'id','case','originalPath'} and isinstance(m['id'],str) and re.fullmatch('[-a-zA-Z0-9_]{1,180}',m['id']) is not None,'LEGACY_LIBRARY_MAPPING')
                require(m['id'] not in ids and type(m['case']) is int and m['case'] in cases and m['case'] not in mapped,'LEGACY_LIBRARY_MAPPING')
                require(isinstance(m['originalPath'],str) and Path(m['originalPath']).is_absolute(),'LEGACY_LIBRARY_PATH')
                require(entries[m['case']]['target']=='cases/'+m['id']+'/case.json','LEGACY_LIBRARY_CASE_PATH')
                ids.add(m['id']);mapped.add(m['case'])


def _json(raw):
    require(len(raw)<=MAX_JSON,'LEGACY_METADATA_BUDGET')
    def pairs(items):
        result={}
        for k,v in items:
            require(k not in result,'LEGACY_METADATA_DUPLICATE_KEY');result[k]=v
        return result
    return json.loads(raw.decode('utf8'),object_pairs_hook=pairs,parse_constant=lambda x:(_ for _ in ()).throw(ValueError('LEGACY_METADATA_NONFINITE')))


def materialize(plan,receipts,files,payload,destination,config,binding,*,progress):
    entries=plan['entries'];results=[];manifests={};produced=set()
    def source(index):
        r=receipts[index];key=payload+'/'+r['custodyPath']
        require(files.stat(key)['size']<=MAX_JSON,'LEGACY_METADATA_BUDGET')
        raw=files.read_bytes(key)
        require(hashlib.sha256(raw).hexdigest()==r['sourceSha256'],'LEGACY_METADATA_SOURCE_HASH')
        return _json(raw)
    def publish(target,value,index,kind):
        require(target not in produced,'LEGACY_DERIVED_TARGET_COLLISION');produced.add(target)
        raw=(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+'\n').encode('utf8')
        require(len(raw)<=MAX_JSON,'LEGACY_METADATA_BUDGET');key=payload+'/'+target
        files.mkdir(key.rpartition('/')[0],parents=True,exist_ok=True)
        if files.exists(key):require(files.read_bytes(key)==raw,'LEGACY_RESUME_DERIVED_MISMATCH')
        else:files.write_bytes(key,raw,exclusive=True)
        require(files.read_bytes(key)==raw,'LEGACY_DERIVED_READBACK')
        result=dict(kind=kind,target=target,sourceSha256=receipts[index]['sourceSha256'],sha256=hashlib.sha256(raw).hexdigest(),bytes=len(raw))
        results.append(result);progress(dict(event='derived-verified',**result))
    # Dependencies are explicit; plan order is not trusted to happen to put
    # cases before projections and library entries.
    for kind in ('case','projection','library'):
        for d in (d for d in plan['derivations'] if d['kind']==kind):
            index=d['entry'];entry=entries[index];value=source(index)
            if kind=='library':
                require(isinstance(value,list) and len(value)==len(d['mappings']),'LEGACY_LIBRARY_MAPPING')
                mappings={m['id']:m for m in d['mappings']};ids=set()
                for item in value:
                    require(isinstance(item,dict) and isinstance(item.get('id'),str) and item['id'] in mappings and item['id'] not in ids,'LEGACY_LIBRARY_MAPPING')
                    ids.add(item['id']);m=mappings[item['id']]
                    require(item.get('path')==m['originalPath'] and m['case'] in manifests,'LEGACY_LIBRARY_PATH')
                    folder=str(PurePosixPath(entries[m['case']]['target']).parent)
                    item['path']=str(Path(binding.root)/destination/folder)
                publish(entry['target'],value,index,kind);continue
            require(isinstance(value,dict) and value.get('status')=='COMPLETE' and value.get('caseHash')==d['caseHash'],'LEGACY_CASE_IDENTITY')
            r=receipts[d['store']];store=entries[d['store']]
            with closing(Connection(Path(binding.root)/payload/store['target'],family=store['family'],config=config,read_only=True)) as db:
                actual=db.logical_manifest()
                require(actual==r['result']['manifest'],'LEGACY_DERIVED_STORE_MISMATCH')
            storage=dict(engine='postgresql-common',path='case.pgstore' if kind=='case' else 'semantic.pgstore',manifest=actual)
            if kind=='case':
                storage['originalManifest']=dict(schema='orbita-legacy-case-manifest-1',path=receipts[index]['custodyPath'],sha256=receipts[index]['sourceSha256'])
            if kind=='projection':
                case=manifests[d['case']]
                require(value.get('projectionHash')==d['projectionHash'] and value.get('sourceSnapshotHash')==case.get('sourceSnapshotHash'),'LEGACY_PROJECTION_IDENTITY')
                old=value.get('storage')
                require(isinstance(old,dict) and old.get('sqlitePath')=='semantic.sqlite' and old.get('sqliteSha256')==r['sourceSha256'] and old.get('sqliteBytes')==r['provenance']['sourceSize'],'LEGACY_PROJECTION_SOURCE_BINDING')
                missing=[m for m in r['provenance']['mappings'] if m['kind']=='absent-nullable-columns']
                if missing:
                    require(len(missing)==1 and tuple(missing[0]['columns'])==OLD_CHUNK_FIELDS and value.get('config',{}).get('representation')!='full_source_text','LEGACY_PROJECTION_COLUMNS')
                    storage['legacyProjectionHash']=dict(schema='sqlite-preview-without-fulltext-columns-1',absentColumns=list(OLD_CHUNK_FIELDS))
            value['storage']=storage;manifests[index]=value
            publish(entry['target'],value,index,kind)
            if kind=='case':publish(str(PurePosixPath(entry['target']).parent)+'/case-seals/'+actual['sha256']+'.json',value,index,'case-seal')
    for d in (d for d in plan['derivations'] if d['kind']=='volume'):
        from .legacy_volume import materialize_volume
        results.append(materialize_volume(d,plan,receipts,files,payload,config,binding,manifests,progress=progress))
    return results
