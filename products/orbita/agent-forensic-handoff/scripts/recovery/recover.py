"""Verify a retained legacy archive in new temporary services.

Inputs, credentials and output remain in explicitly selected local paths.
"""
from pathlib import Path
import argparse, json, os, re, sys


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=('graph', 'postgres'))
    parser.add_argument('--product', type=Path, required=True)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--key-file', type=Path, required=True)
    parser.add_argument('--private-directory', type=Path, required=True)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--max-seconds', type=int, default=21600)
    parser.add_argument('--catalog-file', type=Path)
    parser.add_argument('--operator-file', type=Path)
    parser.add_argument('--memory-mib', type=int, choices=(512, 2048), default=512)
    args = parser.parse_args(argv)
    if os.name != 'nt' or sys.version_info < (3, 12):
        parser.error('This qualification profile requires Windows and Python 3.12 or later.')
    if not 1 <= args.max_seconds <= 21600:
        parser.error('--max-seconds must be between 1 and 21600.')
    if args.kind == 'postgres' and (args.catalog_file is None or args.operator_file is None):
        parser.error('PostgreSQL recovery requires --catalog-file and --operator-file.')
    if args.kind == 'graph' and (args.catalog_file is not None or args.operator_file is not None):
        parser.error('Graph recovery takes its metadata from the authenticated archive.')
    paths = (args.product, args.archive, args.key_file, args.private_directory, args.node, args.catalog_file, args.operator_file)
    if any(value is not None and not value.is_absolute() for value in paths):
        parser.error('Every supplied path must be absolute.')
    package = args.product / 'agent-forensic-handoff/python'
    if not (package / 'orbita_store/service_archive.py').is_file():
        parser.error('--product must identify the reviewed PostgreSQL common-store product.')
    sys.path.insert(0, str(package))
    from orbita_store import StoreError
    from orbita_store.config import plain_local_path
    for value in paths:
        if value is not None:
            plain_local_path(value)
    if not args.archive.is_dir() or not args.key_file.is_file() or not args.node.is_file():
        parser.error('Archive directory, key file and Node executable must already exist.')
    if args.private_directory.exists() or not args.private_directory.parent.is_dir():
        parser.error('Choose a new private directory under an existing protected parent.')
    if any(value is not None and not value.is_file() for value in (args.catalog_file, args.operator_file)):
        parser.error('Catalog and operator files must already exist.')
    args.private_directory.mkdir()
    try:
        common = dict(key_file=args.key_file, private_directory=args.private_directory, node=args.node, max_seconds=args.max_seconds)
        if args.kind == 'graph':
            from pg01_graph_native_restore import restore
            result = restore(args.archive, **common)
            expected = 'PASS_INDEPENDENT_NATIVE_GRAPH_RESTORE'
        else:
            from pg01_legacy_pg_restore import restore
            result = restore(args.archive, catalog_file=args.catalog_file, operator_file=args.operator_file, memory_mib=args.memory_mib, **common)
            expected = 'PASS_INDEPENDENT_ARCHIVE_ONLY_LEGACY_PG_RESTORE'
        status = result['status']
        receipt = args.private_directory / 'RESTORE-RESULT.json'
        print(json.dumps(dict(status=status, receipt=str(receipt), humanAcceptance=False)))
        return int(status != expected)
    except (StoreError, OSError, ValueError, AssertionError) as error:
        code = str(error) if isinstance(error, StoreError) and re.fullmatch(r'ORBITA_PG_[A-Z0-9_]+', str(error)) else type(error).__name__
        print(json.dumps(dict(status='FAIL_PRESERVED', code=code, privateDirectory=str(args.private_directory), humanAcceptance=False)))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
