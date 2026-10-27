"""Reconstruct archived candidate source bytes from verified Git objects."""
from pathlib import Path, PurePosixPath
import argparse
import datetime
import hashlib
import json
import re
import subprocess

HERE = Path(__file__).resolve().parent
REPOSITORY = HERE.parents[1]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--destination', required=True, type=Path)
    args = parser.parse_args()
    assert args.destination.is_absolute(), 'DESTINATION_MUST_BE_ABSOLUTE'
    destination = args.destination.resolve()
    assert not destination.exists(), 'DESTINATION_MUST_BE_NEW'
    assert destination.parent.is_dir(), 'DESTINATION_PARENT_REQUIRED'
    assert not destination.is_relative_to(REPOSITORY), 'DESTINATION_MUST_BE_OUTSIDE_CHECKOUT'
    manifest_path = HERE / 'RECONSTRUCTION.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf8'))
    rows = manifest['filesMapped']
    assert len(rows) == manifest['files'] == 1067
    allowed_roots = set(manifest['candidateDirectories'])
    seen = set()
    for row in rows:
        rel = PurePosixPath(row['path'])
        assert not rel.is_absolute() and '..' not in rel.parts and '\\' not in row['path'] and ':' not in row['path']
        assert rel.parts[0] in allowed_roots and row['path'] not in seen
        seen.add(row['path'])
        assert re.fullmatch(r'[a-f0-9]{40}', row['gitBlob'])
        assert re.fullmatch(r'[a-f0-9]{64}', row['sha256'])
        assert row['method'] in ('exact_git_blob', 'git_blob_lf_to_crlf', 'git_blob_mixed_eol')
        assert isinstance(row['bytes'], int) and 0 <= row['bytes'] <= 64 * 1024 * 1024

    object_ids = sorted({row['gitBlob'] for row in rows})
    result = subprocess.run(
        ['git', 'cat-file', '--batch'], cwd=REPOSITORY,
        input=('\n'.join(object_ids) + '\n').encode('ascii'),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=True,
    )
    raw = result.stdout
    objects = {}
    offset = 0
    for expected in object_ids:
        end = raw.index(b'\n', offset)
        header = raw[offset:end].decode('ascii').split()
        assert len(header) == 3 and header[0] == expected and header[1] == 'blob', 'GIT_OBJECT_MISSING_OR_NOT_BLOB:' + expected
        size = int(header[2])
        assert 0 <= size <= 64 * 1024 * 1024
        start = end + 1
        content = raw[start:start + size]
        assert len(content) == size and raw[start + size:start + size + 1] == b'\n'
        assert hashlib.sha1(b'blob ' + str(size).encode() + b'\0' + content).hexdigest() == expected
        objects[expected] = content
        offset = start + size + 1
    assert offset == len(raw)

    # Validate every reconstructed byte sequence before creating any output.
    recovered = {}
    for row in rows:
        content = objects[row['gitBlob']]
        if row['method'] == 'git_blob_lf_to_crlf':
            content = content.replace(b'\n', b'\r\n')
        elif row['method'] == 'git_blob_mixed_eol':
            crlf = row['crlfLines']
            assert crlf == sorted(set(crlf)) and all(isinstance(n, int) and n > 0 for n in crlf)
            pieces = content.split(b'\n')
            assert not crlf or max(crlf) < len(pieces)
            endings = set(crlf)
            content = b''.join(piece + (b'\r\n' if number in endings else b'\n') for number, piece in enumerate(pieces[:-1], start=1)) + pieces[-1]
        assert len(content) == row['bytes'] and hashlib.sha256(content).hexdigest() == row['sha256'], 'RECONSTRUCTION_HASH_MISMATCH:' + row['path']
        recovered[row['path']] = content
    assert sum(map(len, recovered.values())) == manifest['bytes']

    destination.mkdir()
    for rel, content in recovered.items():
        target = destination / rel
        assert target.resolve().is_relative_to(destination)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream:
            stream.write(content)
    for row in rows:
        assert hashlib.sha256((destination / row['path']).read_bytes()).hexdigest() == row['sha256']
    receipt = {
        'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'status': 'SOURCE_BYTES_RECONSTRUCTED_AND_RECHECKED',
        'manifestSha256': hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
        'files': len(rows), 'bytes': manifest['bytes'], 'gitObjects': len(object_ids),
        'destination': str(destination), 'sourceCommits': manifest['objectsFrom'],
        'historicalCandidatesAccepted': False, 'originalsModified': False,
        'scope': 'Previously untracked candidate source files; installed dependencies, ignored files and runtime state are not reconstructed.',
    }
    (destination / 'RESTORE-RECEIPT.json').write_text(json.dumps(receipt, indent=2), encoding='utf8')
    print(json.dumps(receipt))

if __name__ == '__main__':
    main()
