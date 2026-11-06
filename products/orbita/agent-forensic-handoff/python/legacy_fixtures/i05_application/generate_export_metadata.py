"""Execute only the hash-bound I05 writer's metadata statements on own fixtures.

This is independent of orbita_store's allow-list and never imports it. Original
I05 files are unchanged; no original database or external service is opened.
"""
from pathlib import Path
import ast,hashlib,json,sqlite3,sys

here=Path(__file__).resolve().parent
source=here/'agent-forensic-handoff/python/afh_semantic/postgres_migration.py'
expected='203390cb9beb82c9104c661509e2c92ee3ec5d32000e0b963d11d25fa919e87b'
assert hashlib.sha256(source.read_bytes()).hexdigest()==expected
raw=source.read_text(encoding='utf8');tree=ast.parse(raw)
function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='export_held')
selected=[]
for node in ast.walk(function):
    code=ast.get_source_segment(raw,node) or ''
    if isinstance(node,ast.If) and code.startswith("if any(d['name']=='record_versions' for d in ddls):"):
        selected.append(node)
    elif isinstance(node,ast.Expr) and code.startswith("local.execute('CREATE TABLE orbita_export_revision("):
        selected.append(node)
    elif isinstance(node,ast.Expr) and code.startswith("local.execute('INSERT INTO orbita_export_revision VALUES(1,?)'"):
        selected.append(node)
    elif isinstance(node,ast.For) and code.startswith('for row in ddls:') and "for event in ('INSERT','UPDATE','DELETE'):" in code:
        selected.append(node)
assert len(selected)==4
selected.sort(key=lambda n:n.lineno)
writer=compile(ast.Module(body=selected,type_ignores=[]),str(source),'exec')
root=Path(sys.argv[1]);assert root.is_absolute() and root.is_dir()
results=[]
for name in ('corpus.sqlite3','records.sqlite3'):
    path=root/name;assert path.is_file() and not path.is_symlink()
    db=sqlite3.connect(path)
    try:
        ddls=[dict(name=n,type=t,sql=s) for n,t,s in db.execute("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")]
        assert not any(d['name'].startswith('orbita_export_') for d in ddls)
        exec(writer,{'local':db,'ddls':ddls,'revision':7})
        db.commit();assert db.execute('PRAGMA integrity_check').fetchall()==[('ok',)]
    finally:db.close()
    results.append(dict(name=name,sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
assert hashlib.sha256(source.read_bytes()).hexdigest()==expected
print(json.dumps(dict(writerSha256=expected,files=results)))
