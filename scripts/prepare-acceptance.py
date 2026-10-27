"""Materialize pinned synthetic acceptance prerequisites in a new external lab.

No network, deletion, real corpus, product edits or test execution. Historical
engines generate only the two-record synthetic cases used by the existing tests.
"""
from pathlib import Path, PurePosixPath
import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
SUPPORT = ROOT / 'scripts/acceptance-support'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def safe_relative(value):
    parts = PurePosixPath(value).parts
    assert value and not PurePosixPath(value).is_absolute()
    assert not any(part in ('.', '..', '.git') for part in parts)
    assert not any(c in value for c in ('\\', ':', '\0'))
    return value


def no_links(target):
    for current in [target, *target.parents]:
        if current.exists() or current.is_symlink():
            stat = current.lstat()
            assert not current.is_symlink() and not current.is_junction()
            assert not getattr(stat, 'st_file_attributes', 0) & 0x400


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, timeout=120)


def blobs(identifiers):
    identifiers = sorted(set(identifiers))
    assert all(re.fullmatch(r'[a-f0-9]{40}', value) for value in identifiers)
    raw = subprocess.check_output(['git', 'cat-file', '--batch'], cwd=ROOT,
        input=('\n'.join(identifiers) + '\n').encode(), timeout=120)
    offset, result = 0, {}
    for expected in identifiers:
        end = raw.index(b'\n', offset)
        header = raw[offset:end].decode('ascii').split()
        assert len(header) == 3 and header[:2] == [expected, 'blob'], 'MISSING_GIT_BLOB:' + expected
        size = int(header[2])
        assert 0 <= size <= 64 * 1024 * 1024
        data = raw[end + 1:end + 1 + size]
        assert len(data) == size and raw[end + 1 + size:end + 2 + size] == b'\n'
        assert hashlib.sha1(b'blob ' + str(size).encode() + b'\0' + data).hexdigest() == expected
        result[expected] = data
        offset = end + size + 2
    assert offset == len(raw)
    return result


def direct_python(executable):
    """Bind the native observer to one actual process, not a venv redirector."""
    code = "import sys,os,json;print(json.dumps({'pid':os.getpid(),'base':getattr(sys,'_base_executable',sys.executable),'version':list(sys.version_info[:3])}))"
    observations = []
    selected = executable
    for attempt in range(2):
        no_links(selected)
        assert selected.is_absolute() and selected.is_file()
        process = subprocess.Popen([str(selected), '-I', '-B', '-c', code],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            output, errors = process.communicate(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise
        assert process.returncode == 0 and not errors, 'PYTHON_IDENTITY_PROBE_FAILED'
        observed = json.loads(output)
        assert observed['version'] >= [3, 12, 0]
        observations.append({'requested': str(selected), 'spawnedPid': process.pid,
            'reportedPid': observed['pid'], 'sha256': sha(selected.read_bytes())})
        if observed['pid'] == process.pid:
            return selected, observations
        # Windows venv launchers may create the actual Python as a child. The
        # read-only observer must retain the test's exact spawned-PID binding.
        base = Path(observed['base'])
        assert attempt == 0 and base.is_absolute() and base.resolve() != selected, 'DIRECT_PYTHON_PROCESS_REQUIRED'
        selected = base.resolve()
    raise AssertionError('DIRECT_PYTHON_PROCESS_REQUIRED')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--lab', required=True, type=Path)
    parser.add_argument('--python', type=Path, default=Path(sys.executable))
    args = parser.parse_args()
    assert sys.version_info >= (3, 12), 'PYTHON_3_12_REQUIRED'
    assert sys.platform == 'win32', 'CURRENT_ACCEPTANCE_SHM_OBSERVER_REQUIRES_WINDOWS'
    assert args.lab.is_absolute() and args.python.is_absolute()
    no_links(args.lab)
    no_links(args.python)
    lab, python = args.lab.resolve(), args.python.resolve()
    assert not lab.exists() and lab.parent.is_dir(), 'NEW_LAB_WITH_EXISTING_PARENT_REQUIRED'
    assert not lab.is_relative_to(ROOT) and not ROOT.is_relative_to(lab), 'EXTERNAL_LAB_REQUIRED'
    assert python.is_file()
    python, python_process_observations = direct_python(python)
    node = shutil.which('node')
    assert node
    subprocess.run([node, '--input-type=module', '-e',
        "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(':memory:');if(typeof db.setAuthorizer!=='function')throw Error('NODE_SQLITE_AUTHORIZER_REQUIRED');db.close();"],
        check=True, cwd=ROOT, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
    manifest_bytes = (SUPPORT / 'MANIFEST.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    # All objects must already be fetched. A missing object fails before output.
    for commit in manifest['objectsFrom']:
        assert git('rev-parse', commit + '^{commit}').decode().strip() == commit
    trees = {}
    for version in manifest['legacyVersions']:
        commit = version['commit']
        assert re.fullmatch(r'[a-f0-9]{40}', commit)
        entries = []
        for line in git('ls-tree', '-r', '-z', commit).split(b'\0'):
            if not line:
                continue
            meta, filename = line.split(b'\t', 1)
            mode, kind, object_id = meta.decode().split()
            assert kind == 'blob' and mode in ('100644', '100755'), 'NONREGULAR_HISTORICAL_MEMBER'
            entries.append((safe_relative(filename.decode()), object_id))
        assert entries
        trees[version['version']] = entries
    ids = [r['gitBlob'] for p in manifest['producers'].values() for r in p['files'] if 'gitBlob' in r]
    ids += [obj for entries in trees.values() for _, obj in entries]
    objects = blobs(ids)
    recovered = {}
    for producer, details in manifest['producers'].items():
        assert producer in ('pre03', 'pregraph04')
        files = details['files']
        assert files == sorted(files, key=lambda row: row['file'])
        canonical = [{k: row[k] for k in ('file', 'bytes', 'sha256')} for row in files]
        assert sha(json.dumps(canonical, ensure_ascii=False, separators=(',', ':')).encode()) == details['runtimeSha256']
        for row in files:
            rel = safe_relative(row['file'])
            if 'gitBlob' in row:
                data = objects[row['gitBlob']]
                assert row['method'] in ('exact', 'lf_to_crlf')
                if row['method'] == 'lf_to_crlf':
                    data = data.replace(b'\n', b'\r\n')
            else:
                archived = SUPPORT / safe_relative(row['archivedSource'])
                no_links(archived)
                data = archived.read_bytes()
            assert len(data) == row['bytes'] and sha(data) == row['sha256'], 'PRODUCER_BYTES_CHANGED:' + rel
            name = 'producers/' + producer + '/' + rel
            assert name not in recovered
            recovered[name] = data
    for version, entries in trees.items():
        for rel, obj in entries:
            recovered['packages/package-' + version + '/' + rel] = objects[obj]
    for row in (manifest['shmHelper'], manifest['readerConsumer'], manifest['legacyBuilder']):
        assert sha((SUPPORT / row['file']).read_bytes()) == row['sha256'], 'SUPPORT_BYTES_CHANGED'
    helper = SUPPORT / manifest['shmHelper']['file']
    recovered['helpers/mapped-shm-readonly.py'] = helper.read_bytes()
    lab.mkdir()
    for rel, data in recovered.items():
        target = lab / rel
        assert target.resolve().is_relative_to(lab)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream:
            stream.write(data)
    for directory in ('tmp', 'receipts'):
        (lab / directory).mkdir()
    identities = {v['version']: v['commit'] for v in manifest['legacyVersions']}
    (lab / 'packages/identities.json').write_text(json.dumps(identities, indent=2), encoding='utf8')
    producer = manifest['producers']['pre03']
    identity = {'producer_commit': 'e0676a12c080ca2832b7271aaaa521cbadf02906',
        'producer_copy': str(lab / 'producers/pre03'),
        'runtime': {'sha256': producer['runtimeSha256'], 'files': [
            {k: r[k] for k in ('file', 'bytes', 'sha256')} for r in producer['files']]},
        'role': 'EXACT_HISTORICAL_RUNTIME_RECONSTRUCTED_FROM_VERIFIED_GIT_BYTES'}
    (lab / 'producer-identity.json').write_text(json.dumps(identity, indent=2), encoding='utf8')
    helper_manifest = {'id': 'AFH-SHM04-ACCEPTANCE-HELPER-01', 'schema_version': 1,
        'root': str(lab / 'helpers'), 'helper': {'ref': str(lab / 'helpers/mapped-shm-readonly.py'), 'sha256': sha(helper.read_bytes())},
        'executable': {'ref': str(python), 'sha256': sha(python.read_bytes())}, 'fixed_args': ['-I', '-B'],
        'target_basename': 'ledger.sqlite-shm', 'max_bytes': 16777216, 'timeout_ms': 10000,
        'max_buffer': 1048576, 'platform': 'win32', 'role': 'PRIVATE_ACCEPTANCE_ONLY_NO_GLOBAL_DEPENDENCY'}
    helper_path = lab / 'helpers/helper-manifest.json'
    helper_path.write_text(json.dumps(helper_manifest, indent=2), encoding='utf8')
    env = dict(os.environ, TMP=str(lab / 'tmp'), TEMP=str(lab / 'tmp'), TMPDIR=str(lab / 'tmp'),
        PYTHONDONTWRITEBYTECODE='1', OPENSPEC_TELEMETRY='0')
    env.pop('NODE_OPTIONS', None)
    with (lab / 'legacy-build.log').open('xb') as stream:
        subprocess.run([node, str(ROOT / 'scripts/build-legacy-fixtures.mjs'), str(lab / 'legacy'), str(lab / 'packages')],
            cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT, check=True,
            timeout=900, creationflags=subprocess.CREATE_NO_WINDOW)
    for rel, data in recovered.items():
        assert (lab / rel).read_bytes() == data, 'PREPARATION_MODIFIED_PINNED_INPUT:' + rel
    environment = {'AFH_ACCEPTANCE_RUN': str(lab / 'receipts'),
        'AFH_READER_CLOSURE_BUILDER': str(ROOT / 'scripts/reader-corpus-consumer.mjs'),
        'AFH_LEGACY_FIXTURES': str(lab / 'legacy/report.json'),
        'AFH_PRE03_PRODUCER_IDENTITY': str(lab / 'producer-identity.json'),
        'AFH_PREGRAPH04_PRODUCER': str(lab / 'producers/pregraph04'),
        'AFH_SHM_HELPER_MANIFEST': str(helper_path), 'AFH_SHM_HELPER_MANIFEST_SHA256': sha(helper_path.read_bytes()),
        'TMP': str(lab / 'tmp'), 'TEMP': str(lab / 'tmp'), 'TMPDIR': str(lab / 'tmp'),
        'PYTHONDONTWRITEBYTECODE': '1', 'OPENSPEC_TELEMETRY': '0'}
    receipt = {'status': 'PREREQUISITES_PREPARED_NOT_ACCEPTANCE',
        'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'sourceCommit': git('rev-parse', 'HEAD').decode().strip(),
        'supportManifestSha256': sha(manifest_bytes), 'environment': environment,
        'filesMaterialized': len(recovered), 'historicalRuntimeFiles': sum(len(p['files']) for p in manifest['producers'].values()),
        'producers': {k: p['runtimeSha256'] for k, p in manifest['producers'].items()},
        'shmPythonProcessObservations': python_process_observations,
        'shmPythonExecutable': str(python),
        'legacyCommits': identities, 'legacyReportSha256': sha((lab / 'legacy/report.json').read_bytes()),
        'humanAcceptance': False, 'testsExecuted': False}
    (lab / 'PREPARATION.json').write_text(json.dumps(receipt, indent=2), encoding='utf8')
    print(json.dumps({'status': receipt['status'], 'receipt': str(lab / 'PREPARATION.json')}))


if __name__ == '__main__':
    main()
