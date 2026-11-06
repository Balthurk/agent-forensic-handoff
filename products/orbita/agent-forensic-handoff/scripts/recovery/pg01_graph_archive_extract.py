"""Authenticated archive consumer: create only a fresh owned staging tree."""
import hashlib,json,os,pathlib,re,stat,sys,tarfile
canonical=lambda v:json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
manifest=pathlib.Path('/staging/snapshot-files.json')
assert manifest.is_file() and not manifest.is_symlink() and manifest.stat().st_size<=4*1024**2
expected=json.loads(manifest.read_text());inventory=expected['inventory']
assert expected['sha256']==sys.argv[1]==hashlib.sha256(canonical(inventory)).hexdigest()
assert inventory['fileCount']==len(inventory['files'])<=5000 and inventory['totalBytes']<=2*1024**3
assert inventory['totalBytes']==sum(v['bytes'] for v in inventory['files'])
tables={'edgestore','edgestore_lock_','graphindex','graphindex_lock_','janusgraph_ids','system_properties','system_properties_lock_','systemlog','txlog'}
names=[]
for value in inventory['files']:
    parts=pathlib.PurePosixPath(value['path']).parts
    assert len(parts)==4 and parts[0] in ('node1','node2','node3') and parts[1]=='orbita_f30' and parts[2] in tables
    assert parts[3] in ('manifest.json','schema.cql') or re.fullmatch('[a-z]{2}-[0-9]+-big-[A-Za-z0-9.]+',parts[3])
    assert str(pathlib.PurePosixPath(*parts))==value['path'] and type(value['bytes']) is int and value['bytes']>=0
    assert re.fullmatch('[a-f0-9]{64}',value['sha256']);names.append(value['path'])
assert len(set(names))==len(names)
root=pathlib.Path('/staging/data');assert root.resolve()==root and not root.exists();root.mkdir(mode=0o700)
count=total=0
with tarfile.open(fileobj=sys.stdin.buffer,mode='r|') as archive:
    for entry in archive:
        assert count<len(inventory['files']);want=inventory['files'][count]
        assert entry.isfile() and not entry.issym() and not entry.islnk() and not entry.pax_headers
        assert entry.name==want['path'] and entry.size==want['bytes'] and entry.mtime==want['mtimeNs']//10**9
        target=root/pathlib.PurePosixPath(entry.name);target.parent.mkdir(parents=True,exist_ok=True)
        assert target.resolve()==target and all(not parent.is_symlink() for parent in target.parents)
        source=archive.extractfile(entry);digest=hashlib.sha256();size=0
        fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as sink:
            while block:=source.read(1024**2):sink.write(block);size+=len(block);digest.update(block)
            sink.flush();os.fsync(sink.fileno())
        assert size==want['bytes'] and digest.hexdigest()==want['sha256']
        count+=1;total+=size
assert count==inventory['fileCount'] and total==inventory['totalBytes']
while sys.stdin.buffer.read(1024**2):pass
receipt=root.parent/'EXTRACTED.json'
with receipt.open('x') as out:
    json.dump(dict(status='PASS_ALL_NATIVE_SNAPSHOT_FILES_EXTRACTED',files=count,bytes=total,inventorySha256=expected['sha256']),out);out.flush();os.fsync(out.fileno())
