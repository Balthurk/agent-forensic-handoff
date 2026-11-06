"""Read-only, bounded planning for an explicitly selected legacy data root.

This is an import boundary, not runtime storage discovery. Unknown SQLite files
are errors. The planner never executes source DDL or changes an original; the
importer subsequently verifies every hash and the installed relational schema.
"""
from contextlib import ExitStack
import argparse,hashlib,json,os,re,stat,sys
from pathlib import Path,PurePosixPath

from . import StoreError
from .config import plain_local_path,require
from .legacy_import import _guard_root,_path,MAX_PLAN_ENTRIES,serialize_plan
from .legacy_metadata import _json,check_derivations,MAX_JSON
from .legacy_sqlite import NativeReadHold
from afh_semantic.path_safety import native_path

SQLITE=b'SQLite format 3\0'
FAMILIES={'corpus-plans.sqlite':'library','documents.sqlite':'documents',
          'pipeline.sqlite':'pipeline','turns.sqlite':'turns',
          'embedding-cache/embeddings.sqlite':'embedding','reevaluation/queue.sqlite':'reevaluation',
          'semantic/graph-publications/graph.sqlite3':'graph',
          'semantic/graph-publications/janus-ledger.sqlite3':'graph_ledger','volume/operational.sqlite':'volume'}
SEMANTIC=r'semantic/(?:causal/|collectives/|decisions/|identities/|intelligence/|learning/|retrospectives/|supports/)?'
CASE=r'cases/[-a-zA-Z0-9_]{1,180}'
PROJECTION=CASE+r'/projections/[-a-zA-Z0-9_]{1,180}'
INCOMPLETE_STAGE=r'cases/document-[0-9a-f]{64}\.document-staging-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp-[1-9][0-9]{0,9}/case\.sqlite'


def enumerate_files(root,*,max_files,max_bytes):
    found={};folders=0;total=0
    root=native_path(plain_local_path(root))
    require(root.is_dir(),'LEGACY_PLAN_SOURCE_ROOT')
    for folder,dirs,names in os.walk(root,followlinks=False):
        dirs.sort();names.sort();folders+=1
        require(folders<=max_files*4,'LEGACY_PLAN_DIRECTORY_BUDGET')
        for name in dirs+names:
            p=Path(folder)/name;s=p.lstat()
            require(not s.st_file_attributes&stat.FILE_ATTRIBUTE_REPARSE_POINT,'LEGACY_PLAN_LINK')
            rel=p.relative_to(root).as_posix();_path(rel)
            if name in dirs:require(stat.S_ISDIR(s.st_mode),'LEGACY_PLAN_DIRECTORY')
            else:
                require(stat.S_ISREG(s.st_mode) and s.st_nlink==1,'LEGACY_REGULAR_UNALIASED_FILE_REQUIRED')
                key=rel.casefold();require(key not in found,'LEGACY_PLAN_DUPLICATE')
                total+=s.st_size;require(len(found)<max_files and total<=max_bytes,'LEGACY_PLAN_SOURCE_BUDGET')
                found[key]=dict(path=rel,bytes=s.st_size,device=s.st_dev,inode=s.st_ino,mtime=s.st_mtime_ns)
    require(bool(found),'LEGACY_PLAN_EMPTY')
    return {v['path']:v for k,v in sorted(found.items())}


def classify(name,header,size,names,descendants):
    target=name;kind='file';family=FAMILIES.get(name)
    if re.fullmatch(INCOMPLETE_STAGE,name):
        require(size==0 and header==b'' and descendants[str(PurePosixPath(name).parent)]==1,'LEGACY_PLAN_INCOMPLETE_STAGE')
        return dict(target=target,kind='custody')
    if re.fullmatch(CASE+r'/case\.sqlite',name):family='case'
    elif re.fullmatch(PROJECTION+r'/semantic\.sqlite',name):family='vector'
    elif re.fullmatch(SEMANTIC+r'corpus\.sqlite3',name):family='corpus'
    elif re.fullmatch(SEMANTIC+r'records\.sqlite3',name):family='semantic'
    side=re.fullmatch(r'(.+\.(?:sqlite|sqlite3|db))-(wal|journal|shm)',name)
    control=name=='library-lock.sqlite' or any(x in name.lower() for x in ('orbita-access','orbita-restore','postgres-storage','operator.json','runtime.json','capability')) or name=='service.lock'
    if side:
        require(side[1] in names,'LEGACY_PLAN_ORPHAN_SIDECAR')
        require(side[2]=='shm' or size==0,'LEGACY_COHERENT_SNAPSHOT_REQUIRED')
        return dict(target=target,kind='custody')
    if control:
        if name=='library-lock.sqlite':target='library-lock.pgstore'
        return dict(target=target,kind='custody')
    if family:
        require(header==SQLITE,'LEGACY_PLAN_SQLITE_HEADER')
        target='volume/legacy-source.pgstore' if family=='volume' else re.sub(r'\.sqlite3?$','.pgstore',name)
        return dict(target=target,kind='store',family=family)
    require(header!=SQLITE and not name.endswith(('.sqlite','.sqlite3','.db','.pgstore')),'LEGACY_PLAN_UNKNOWN_STORE')
    if name=='library.json' or re.fullmatch(CASE+r'/case\.json',name) or re.fullmatch(PROJECTION+r'/projection\.json',name):kind='custody'
    if name.startswith('volume/lake/'):
        require(re.fullmatch(r'volume/lake/[^/]+\.parquet',name) is not None,'LEGACY_PLAN_UNKNOWN_LAKE_MEMBER')
        kind='custody'
    return dict(target=target,kind=kind)


def build_plan(root,*,max_files=MAX_PLAN_ENTRIES,max_bytes=50*1024**3):
    require(type(max_files) is int and 1<=max_files<=MAX_PLAN_ENTRIES and type(max_bytes) is int and 1<=max_bytes<=50*1024**3,'LEGACY_PLAN_LIMITS')
    require(Path(root).is_absolute(),'LEGACY_ABSOLUTE_SOURCE_REQUIRED');root=plain_local_path(root)
    before=enumerate_files(root,max_files=max_files,max_bytes=max_bytes)
    with ExitStack() as stack:
        _guard_root(root,stack)
        held={name:stack.enter_context(NativeReadHold(root/name,max_bytes=max_bytes)) for name in before}
        require(before==enumerate_files(root,max_files=max_files,max_bytes=max_bytes),'LEGACY_PLAN_ENUMERATION_CHANGED')
        entries=[];descendants={}
        for name in held:
            for directory in PurePosixPath(name).parents:
                key=str(directory);descendants[key]=descendants.get(key,0)+1
        for name,source in held.items():
            require(source.identity.st_size==before[name]['bytes'],'LEGACY_SOURCE_CHANGED')
            entries.append(dict(source=name,sha256=source.sha256,**classify(name,source.file.read(16),source.identity.st_size,held,descendants)))
        indices={e['source']:i for i,e in enumerate(entries)};derived=[];cases={}
        def metadata(name):
            h=held[name];require(h.identity.st_size<=MAX_JSON,'LEGACY_METADATA_BUDGET');h.file.seek(0)
            return _json(h.file.read())
        def required(name,family):
            i=indices.get(name);require(i is not None and entries[i].get('family')==family,'LEGACY_PLAN_MISSING_STORE');return i
        for name,i in indices.items():
            if not re.fullmatch(CASE+r'/case\.json',name):continue
            value=metadata(name)
            require(isinstance(value,dict) and value.get('status')=='COMPLETE' and isinstance(value.get('caseHash'),str) and re.fullmatch('[0-9a-f]{64}',value['caseHash']),'LEGACY_CASE_IDENTITY')
            folder=PurePosixPath(name).parent;cases[str(folder)]=(i,value)
            derived.append(dict(kind='case',entry=i,store=required(str(folder/'case.sqlite'),'case'),caseHash=value['caseHash']))
        for name,i in indices.items():
            if not re.fullmatch(PROJECTION+r'/projection\.json',name):continue
            folder=PurePosixPath(name).parent;parent=str(folder.parent.parent);require(parent in cases,'LEGACY_PLAN_PROJECTION_CASE')
            case_index,case=cases[parent];value=metadata(name)
            require(isinstance(value,dict) and value.get('status')=='COMPLETE' and value.get('caseHash')==case['caseHash'] and value.get('sourceSnapshotHash')==case.get('sourceSnapshotHash') and isinstance(value.get('projectionHash'),str) and re.fullmatch('[0-9a-f]{64}',value['projectionHash']),'LEGACY_PROJECTION_IDENTITY')
            derived.append(dict(kind='projection',entry=i,store=required(str(folder/'semantic.sqlite'),'vector'),case=case_index,caseHash=value['caseHash'],projectionHash=value['projectionHash']))
        # Orphan case/projection stores must not become invisible to readers.
        require({d['store'] for d in derived}=={i for i,e in enumerate(entries) if e.get('family') in ('case','vector')},'LEGACY_PLAN_ORPHAN_CONTENT_STORE')
        if 'library.json' in indices:
            value=metadata('library.json');require(isinstance(value,list) and len(value)<=10000,'LEGACY_LIBRARY_MAPPING');mappings=[]
            for item in value:
                require(isinstance(item,dict) and isinstance(item.get('id'),str) and 'cases/'+item['id'] in cases and isinstance(item.get('path'),str) and Path(item['path']).is_absolute(),'LEGACY_LIBRARY_MAPPING')
                mappings.append(dict(id=item['id'],case=cases['cases/'+item['id']][0],originalPath=item['path']))
            derived.append(dict(kind='library',entry=indices['library.json'],mappings=mappings))
        parquet=[i for i,e in enumerate(entries) if e['source'].startswith('volume/lake/')]
        if 'volume/operational.sqlite' in indices:
            derived.append(dict(kind='volume',store=indices['volume/operational.sqlite'],cases=[i for i,v in cases.values()],parquet=parquet))
        else:require(not parquet,'LEGACY_PLAN_ORPHAN_LAKE')
        plan=dict(schema='orbita-legacy-plan-2' if derived else 'orbita-legacy-plan-1',sourceRoot=str(root),entries=entries)
        if derived:plan['derivations']=derived;check_derivations(plan)
        targets=sorted(e['target'].casefold() for e in entries)
        require(len(set(targets))==len(targets) and not any(b.startswith(a+'/') for a,b in zip(targets,targets[1:])),'LEGACY_TARGET_COLLISION')
        serialize_plan(plan)
        for h in held.values():h.verify()
        require(before==enumerate_files(root,max_files=max_files,max_bytes=max_bytes),'LEGACY_PLAN_ENUMERATION_CHANGED')
        return plan


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',required=True);parser.add_argument('--output',required=True)
    args=parser.parse_args(argv)
    try:
        require(Path(args.source).is_absolute() and Path(args.output).is_absolute(),'CLI_ABSOLUTE_PATH_REQUIRED')
        output=plain_local_path(args.output);root=plain_local_path(args.source)
        require(not output.is_relative_to(root),'LEGACY_PLAN_OUTPUT_INSIDE_SOURCE')
        plan=build_plan(root);raw=serialize_plan(plan)
        with native_path(output).open('xb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
        print(json.dumps(dict(status='PASS_READ_ONLY_PLAN',planSha256=hashlib.sha256(raw).hexdigest(),entries=len(plan['entries']),stores=sum(e['kind']=='store' for e in plan['entries']),custody=sum(e['kind']=='custody' for e in plan['entries']),derivations=len(plan.get('derivations',[])),imported=False)))
        return 0
    except BaseException as error:
        code=str(error) if isinstance(error,StoreError) and re.fullmatch('ORBITA_PG_[A-Z0-9_]+',str(error)) else 'ORBITA_PG_PLAN_INPUT_OR_SCAN_FAILED'
        print(json.dumps(dict(status='FAIL',code=code,imported=False)));return 1


if __name__=='__main__':raise SystemExit(main())
