"""Bounded writable loader copy; the authenticated staging tree stays read-only.

Executed inside a new Cassandra helper, with /staging read-only and a private
128 MiB /loader-input tmpfs. No original service or volume is mounted here.
"""
import hashlib, json, pathlib, re, signal, subprocess, sys, time

MAX_BYTES = 112 * 1024**2
MAX_FILES = 2048


def checked_entries(node, table, entries):
    assert type(node) is int and 1 <= node <= 3
    assert table in ('edgestore', 'edgestore_lock_', 'graphindex', 'graphindex_lock_', 'janusgraph_ids', 'system_properties', 'system_properties_lock_', 'systemlog', 'txlog')
    prefix = 'node' + str(node) + '/orbita_f30/' + table + '/'
    assert isinstance(entries, list) and 0 < len(entries) <= MAX_FILES
    names = []
    for entry in entries:
        assert set(entry) == {'path', 'bytes', 'sha256'}
        assert entry['path'].startswith(prefix)
        name = entry['path'][len(prefix):]
        assert name in ('manifest.json', 'schema.cql') or re.fullmatch(r'[a-z]{2}-[0-9]+-big-[A-Za-z0-9.]+', name)
        assert type(entry['bytes']) is int and entry['bytes'] >= 0
        assert re.fullmatch(r'[a-f0-9]{64}', entry['sha256'])
        names.append(name)
    assert len(set(names)) == len(names)
    assert sum(entry['bytes'] for entry in entries) <= MAX_BYTES
    return prefix, names


def verify_input(directory, entries, node, table):
    prefix, names = checked_entries(node, table, entries)
    directory = pathlib.Path(directory)
    assert directory.is_dir() and not directory.is_symlink()
    assert {file.name for file in directory.iterdir()} == set(names)
    total = 0
    for entry, name in zip(entries, names):
        file = directory / name
        stat = file.lstat()
        assert file.is_file() and not file.is_symlink() and stat.st_nlink == 1
        assert stat.st_size == entry['bytes']
        digest = hashlib.sha256()
        with file.open('rb') as stream:
            while True:
                block = stream.read(1024**2)
                if not block:
                    break
                digest.update(block)
        assert digest.hexdigest() == entry['sha256']
        total += stat.st_size
    return dict(files=len(entries), bytes=total, exactNames=True, hashesEqual=True, linksAfterClose=1)


def prepare_input(node, table, entries):
    prefix, names = checked_entries(node, table, entries)
    source = pathlib.Path('/staging/data') / prefix
    destination = pathlib.Path('/loader-input') / prefix
    assert source.resolve() == source and source.is_dir() and not source.is_symlink()
    assert {file.name for file in source.iterdir()} == set(names)
    assert not destination.exists()
    destination.mkdir(parents=True)
    for entry, name in zip(entries, names):
        original = source / name
        stat = original.lstat()
        assert original.is_file() and not original.is_symlink() and stat.st_nlink == 1 and stat.st_size == entry['bytes']
        digest = hashlib.sha256()
        with original.open('rb') as input_stream, (destination / name).open('xb') as output:
            while True:
                block = input_stream.read(1024**2)
                if not block:
                    break
                digest.update(block)
                output.write(block)
        assert digest.hexdigest() == entry['sha256']
    verified = verify_input(destination, entries, node, table)
    return source, destination, verified


def main():
    request = json.loads(sys.argv[1])
    assert set(request) == {'node', 'table', 'entries', 'nodes', 'seconds'}
    assert request['seconds'] == 180
    assert isinstance(request['nodes'], list) and len(request['nodes']) == 3
    assert all(re.fullmatch(r'orbita-graph-restore-[0-9a-f-]+-c[1-3]', node) for node in request['nodes'])
    started = time.monotonic()
    source = destination = None
    process = None
    stdout = stderr = b''
    timed_out = False
    copy_before = source_after = copy_after = None
    error = None
    exit_code = None
    try:
        source, destination, copy_before = prepare_input(request['node'], request['table'], request['entries'])
        command = ['sstableloader', '--no-progress', '--nodes', ','.join(request['nodes']), str(destination)]
        remaining = request['seconds'] - (time.monotonic() - started)
        assert remaining > 0
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            stdout, stderr = process.communicate(timeout=remaining)
        except subprocess.TimeoutExpired:
            timed_out = True
            import os
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
        exit_code = process.returncode
    except BaseException as failure:
        error = type(failure).__name__
    finally:
        if process is not None and process.poll() is None:
            import os
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(5)
        try:
            if source is not None:
                source_after = verify_input(source, request['entries'], request['node'], request['table'])
            if destination is not None:
                copy_after = verify_input(destination, request['entries'], request['node'], request['table'])
        except BaseException as failure:
            error = (error or '') + ' INPUT_VERIFICATION_' + type(failure).__name__
        if time.monotonic() - started > request['seconds']:
            timed_out = True
        value = dict(exit=exit_code if error is None else 1, timedOut=timed_out, seconds=time.monotonic()-started, stdout=stdout[:65536].decode(errors='replace'), stderr=stderr[:65536].decode(errors='replace'), stdoutBytes=len(stdout), stderrBytes=len(stderr), stdoutSha256=hashlib.sha256(stdout).hexdigest(), stderrSha256=hashlib.sha256(stderr).hexdigest(), copyBefore=copy_before, sourceAfter=source_after, copyAfter=copy_after, copyError=error, sourceReadOnly=True)
        print(json.dumps(value), flush=True)


if __name__ == '__main__':
    main()
