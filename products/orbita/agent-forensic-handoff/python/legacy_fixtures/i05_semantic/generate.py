"""Synthetic SQLite oracle, isolated from the operational import/runtime path."""
import hashlib,json,os
from pathlib import Path
import sys

HERE=Path(__file__).resolve().parent
manifest=json.loads((HERE/'SOURCE-MANIFEST.json').read_text(encoding='utf8'))
assert all(hashlib.sha256((HERE/name).read_bytes()).hexdigest()==digest for name,digest in manifest['files'].items())
assert not any(name.startswith(('ORBITA_','AFH_','PG','OPENAI_','ANTHROPIC_','CODEX_','NODE_','PYTHONPATH','PYTHONHOME')) for name in os.environ)
root=Path(sys.argv[1]);assert root.is_absolute() and root.is_dir() and not list(root.iterdir())
def audit(event,args):
    if event in ('socket.connect','socket.bind','subprocess.Popen','os.system'):raise RuntimeError('LEGACY_ORACLE_EXTERNAL_ACTION_FORBIDDEN')
sys.addaudithook(audit)
sys.path.insert(0,str(HERE))
from afh_semantic.host import dispatch

def source(id,text,conversation='A'):
    sha=hashlib.sha256(text.encode()).hexdigest()
    return dict(id=id,revision=sha,payload_sha256=sha,representation_id=id,occurrence_id='occ-'+id,source_conversation_id=conversation,text=text,text_sha256=sha,record_sha256=sha,role='user',verified=True,coordinate_space='AFH-representation-text-v1')
sources=[source('rep-rule','Alfa permite staging sólo si pasa QA.'),source('rep-revoke','Alfa revoca staging hasta nueva revisión.','B')]
semantic=root/'semantic';semantic.mkdir()
def call(op,**args):return dispatch(dict(root=str(semantic),scope='scope',sources=sources,op=op,**args))
def extract(index,name,relation=None):
    item=sources[index];e=[dict(sourceId=item['id'],quote=item['text'])]
    clause=dict(key=name,quote=item['text'],predicate='staging',polarity='negative' if index else 'positive',resolution='resolved',arguments=[dict(role='project',literal='Alfa',interpreted='',evidence=e)],conditions=[],temporal=[],relations=[])
    if relation:clause['relations']=[dict(kind='retracts',targetClauseVersionId=relation,evidence=e)]
    act=dict(key=name,targetSourceId=item['id'],type='policy',summary=item['text'],modality='directive',clauses=[clause])
    result=call('extract',draft=dict(acts=[act]),producer='synthetic-fixture',sourceCut='cut',requestId='request-'+name)
    assert result['errors']==[];return result['records'][0]
first=extract(0,'rule');cut=first['recorded_at'];second=extract(1,'revocation',first['payload']['semantic_unit']['clauses'][0]['clause_version_id'])
query=dict(question='staging',knownAt='2099-01-01T00:00:00Z',validAt='2026-10-25T00:00:00Z')
before=call('context_query',**query)
restricted=dispatch(dict(root=str(semantic),scope='scope',sources=sources[:1],op='context_query',**query))
entries=[]
for name,family in [('corpus.sqlite3','corpus'),('records.sqlite3','semantic')]:
    path=semantic/name
    entries.append(dict(source='semantic/'+name,target='semantic/'+name.replace('.sqlite3','.pgstore'),kind='store',family=family,sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
sys.stdout.buffer.write(json.dumps(dict(sources=sources,first=first,second=second,cut=cut,before=before,beforeRestricted=restricted,plan=dict(schema='orbita-legacy-plan-1',sourceRoot=str(root),entries=entries)),ensure_ascii=False).encode('utf8'))
