"""Synthetic volume oracle using the hash-qualified, unchanged I05 writer."""
from pathlib import Path
import hashlib,importlib.util,json,os,sqlite3,sys

here=Path(__file__).resolve().parent
manifest=json.loads((here/'SOURCE-MANIFEST.json').read_text(encoding='utf8'))
def verify():
    for name,sha in manifest['files'].items():assert hashlib.sha256((here/name).read_bytes()).hexdigest()==sha,name
verify()
assert not any(k.startswith(('ORBITA_','OPENAI_','ANTHROPIC_','JEV_','CODEX_','AFH_SEMANTIC_PG')) for k in os.environ)
root=Path(sys.argv[1]);assert root.is_absolute() and not (root/'volume').exists()
spec=importlib.util.spec_from_file_location('original_i05_volume',here/'app/volume_store.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
original=(root/'cases/a/case.json').read_bytes();case=json.loads(original);library=json.loads((root/'library.json').read_text())
source=dict(id='a',caseHash=case['caseHash'],manifestHash=hashlib.sha256(original).hexdigest(),metadata={k:v for k,v in library[0].items() if k!='path'})
catalog=dict(sources=[source],token=module.digest(module.canonical([source])))
store=module.Store(root)
try:
    store.prepare(catalog);rows=[]
    for i in range(3):
        raw=module.canonical(dict(type='synthetic',body='literal ñ😀 '+str(i)))
        rows.append(dict(sourceId='a',uri='synthetic://record/'+str(i),ordinal=i,kind='synthetic',raw=raw,sha=module.digest(raw),caseHash=case['caseHash']))
    store.append('a',0,3,rows,True)
    for i in range(3):store.lake(1)
    assert store.verify_lake()['status']=='VERIFIED'
    page=store.query(dict(limit=1));next_page=store.query(dict(limit=1,cursor=page['cursor']))
    result=dict(catalog=catalog,page=page,nextPage=next_page,secretSha256=module.digest(store.get('secret')),instance=store.get('instance'),generation=store.get('generation'))
finally:store.close()
db=sqlite3.connect(root/'volume/operational.sqlite')
try:db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
finally:db.close()
verify();print(json.dumps(result,ensure_ascii=False))
