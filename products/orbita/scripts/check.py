"""Run the three cumulative suites against this source snapshot, with external logs."""
from pathlib import Path
import argparse,datetime,hashlib,json,os,re,subprocess,sys,time

root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--lab',type=Path)
parser.add_argument('--list',action='store_true')
args=parser.parse_args()
core=sorted((root/'agent-forensic-handoff/test').glob('*.test.js'))
app=sorted((root/'app').glob('*.test.mjs'))
python=sorted((root/'agent-forensic-handoff/python').glob('test_*.py'))
groups={'core':core,'app':app,'python':python}
assert all(groups.values()),'TEST_DISCOVERY_EMPTY'
if args.list:
 print(json.dumps({k:[p.relative_to(root).as_posix() for p in v] for k,v in groups.items()},indent=2))
 raise SystemExit(0)
assert args.lab,'Pass --lab with a new directory outside the source checkout'
lab=args.lab.resolve()
assert not lab.is_relative_to(root) and not lab.exists(),'LOG_DIRECTORY_MUST_BE_NEW_AND_EXTERNAL'
for key in ('AFH_VOLUME_PG_TEST_CONFIG','AFH_SEMANTIC_PG_TEST_CONFIG','AFH_G1_JANUS_TEST_CONFIG'):
 assert os.environ.get(key) and Path(os.environ[key]).is_file(),'MISSING_TEST_CONFIG:'+key
manifest=json.loads((root/'SOURCE-MANIFEST.json').read_text(encoding='utf8'))
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
before={row['path']:sha(root/row['path']) for row in manifest['files']}
assert all(before[row['path']]==row['publishedCandidateSha256'] for row in manifest['files']),'SOURCE_MANIFEST_MISMATCH'
lab.mkdir(parents=True)
env={**os.environ,'PYTHONUTF8':'1','PYTHONDONTWRITEBYTECODE':'1'}
env.setdefault('AFH_VOLUME_PYTHON',sys.executable)
for key in list(env):
 if key in ('AFH_COSMOS_DATA','AFH_G1_JANUS_CONFIG','AFH_SEMANTIC_PG_CONFIG','AFH_MANAGED','NODE_OPTIONS','ORBITA_ACCESS_DIAGNOSTIC') or (key.startswith('AFH_') and 'CRASH' in key):env.pop(key,None)
suites=[('core',['node','--test','--test-reporter=tap',*map(str,core)],root/'agent-forensic-handoff'),('app',['node','--test','--test-reporter=tap',*map(str,app)],root),('python',[sys.executable,'-X','utf8','-B','-m','unittest','discover','-s',str(root/'agent-forensic-handoff/python'),'-p','test_*.py','-v'],root)]
rows=[];errors=[]
for name,command,cwd in suites:
 start=time.monotonic()
 try:
  run=subprocess.run(command,cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=900)
  output=run.stdout;code=run.returncode
 except subprocess.TimeoutExpired as failure:
  output=failure.stdout or b'';code=124
 (lab/(name+'.log')).write_bytes(output);text=output.decode('utf8',errors='replace')
 if name=='python':
  count=re.search(r'Ran (\d+) tests? in ',text);count=int(count[1]) if count else 0
  skipped=sum(map(int,re.findall(r'skipped=(\d+)',text)))
  passed=count-skipped if code==0 else None
  if not re.search(r'^OK(?:\s*\([^\n]*\))?\s*$',text,re.M):errors.append(name+':NOT_OK')
 else:
  def metric(key):
   values=re.findall(r'^# '+key+r' (\d+)$',text,re.M);return int(values[-1]) if values else -1
  count,passed,skipped=metric('tests'),metric('pass'),metric('skipped')
  if any(metric(key)!=0 for key in ('fail','cancelled','todo')) or passed!=count-skipped:errors.append(name+':FAILED_OR_INCOMPLETE')
 expected_skip=1 if name=='core' and os.name=='nt' else 0
 if expected_skip and re.findall(r'^ok \d+ - (.*?) # SKIP[^\n]*$',text,re.M)!=['symlink transcript input is refused by default']:errors.append(name+':UNEXPECTED_SKIP')
 if code or count<=0 or skipped!=expected_skip:errors.append(name+':EXIT_COUNT_OR_SKIP')
 rows.append(dict(name=name,exit=code,tests=count,passed=passed,skipped=skipped,seconds=round(time.monotonic()-start,3),logSha256=sha(lab/(name+'.log'))))
 print(json.dumps(rows[-1]),flush=True)
if before!={rel:sha(root/rel) for rel in before}:errors.append('SOURCE_CHANGED_DURING_TESTS')
receipt=dict(at=datetime.datetime.now(datetime.timezone.utc).isoformat(),status='FAIL' if errors else 'PASS',suites=rows,errors=errors,sourceFiles=before,humanAcceptance=False,scope='Cumulative source tests only; real UI and operational backup/restore are separate requirements.')
(lab/'RESULT.json').write_text(json.dumps(receipt,indent=2),encoding='utf8')
raise SystemExit(bool(errors))
