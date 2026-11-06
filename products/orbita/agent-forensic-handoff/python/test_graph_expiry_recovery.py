"""Temporal recovery contracts with synthetic cells; real restore is a separate gate."""
from pathlib import Path
import contextlib
import copy
import hashlib
import io
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

RECOVERY = Path(__file__).resolve().parents[1] / 'scripts/recovery'
sys.path.insert(0, str(RECOVERY))
from orbita_store import StoreError
from orbita_store.service_archive import canonical
from pg01_graph_content_catalog import same_cells
from pg01_graph_expiry import compare_at_restore, project_native_cells, validate_catalog
from pg01_graph_restore_layout import TABLES, ttl_horizon
import pg01_graph_native_restore
import recover


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def cell(name, value='synthetic value', written=123, expiring=False):
    payload = canonical([name, value, written, expiring])
    return [hashlib.sha256(name.encode()).hexdigest(), hashlib.sha256(payload).hexdigest(), len(payload)]


PERMANENT = cell('permanent')
EXPIRED = cell('expired', expiring=True)
LIVE = cell('live', expiring=True)
NOW = 10000


def catalog(*, permanent=True, expired=True, live=True, observed=False):
    entries = {name: [] for name in TABLES}; expirations = {name: [] for name in TABLES}
    if permanent:
        entries['edgestore'].append(PERMANENT.copy())
    if expired:
        entries['txlog'].append(EXPIRED.copy()); expirations['txlog'].append([EXPIRED[0], 9000, 9003, 8900])
    if live:
        entries['txlog'].append(LIVE.copy()); expirations['txlog'].append([LIVE[0], 20000, 20003, 19900])
    for rows in expirations.values():
        rows.sort()
    tables = {name: dict(entries=sorted(rows), rows=len(rows), typedBytes=sum(r[2] for r in rows), sha256=digest(sorted(rows))) for name, rows in entries.items()}
    logical = dict(format='orbita-cassandra-full-cells-1', keyspace='orbita_f30', schemaCql='synthetic complete schema',
                   partitioner='org.apache.cassandra.dht.Murmur3Partitioner', tables=tables)
    value = dict(status='PASS_COMPLETE_READ_ONLY_CASSANDRA_CELLS', logical=logical, logicalSha256=digest(logical), expirations=expirations,
                 rows=sum(t['rows'] for t in tables.values()), typedBytes=sum(t['typedBytes'] for t in tables.values()), clockStart=100, clockEnd=102)
    if observed:
        value.update(clockStart=10005, clockEnd=10006)
        for row in value['expirations']['txlog']:
            if row[0] == LIVE[0]:
                row[1:] = [20001, 20003, 9996]
    return value


class GraphExpiryTests(unittest.TestCase):
    def setUp(self):
        self.before = catalog(); self.after = copy.deepcopy(self.before)
        self.after.update(clockStart=200, clockEnd=201)
        for row in self.after['expirations']['txlog']:
            row[2] -= 1; row[3] -= 100

    def project(self, **options):
        return project_native_cells(self.before, self.after, observed_at=options.get('observed_at', NOW), remaining_seconds=options.get('remaining_seconds', 100))

    def test_mixed_cells_exact_absence_and_remaining_content_without_input_mutation(self):
        original = canonical([self.before, self.after]); expected, receipt = self.project()
        actual = catalog(expired=False, observed=True)
        result = compare_at_restore(expected, actual, receipt)
        self.assertEqual(result['status'], 'PASS_EXACT_NATIVE_CELLS_AT_RESTORE')
        self.assertEqual(expected['logical'], actual['logical'])
        self.assertEqual(expected['rows'], 2)
        self.assertEqual(receipt['expired']['txlog'], [[EXPIRED[0], 9000, 9002]])
        self.assertEqual(receipt['retainedExpiring']['txlog'], [[LIVE[0], 20000, 20002]])
        self.assertEqual((receipt['expiredCells'], receipt['retainedExpiringCells'], receipt['unchangedPermanentCells']), (1, 1, 1))
        self.assertEqual(result['expiredCellsAbsent'], 1); self.assertFalse(result['capturedNativeCellsEqual'])
        self.assertEqual(receipt['requiredLiveUntilUnixSeconds'], NOW + 100 + 3600)
        self.assertEqual(canonical([self.before, self.after]), original)

    def test_lost_permanent_cell_is_rejected(self):
        expected, receipt = self.project()
        with self.assertRaisesRegex(StoreError, 'COMPLETE_NATIVE_CELLS_CHANGED'):
            compare_at_restore(expected, catalog(expired=False, permanent=False, observed=True), receipt)

    def test_lost_live_expiring_cell_is_rejected(self):
        expected, receipt = self.project()
        with self.assertRaisesRegex(StoreError, 'COMPLETE_NATIVE_CELLS_CHANGED'):
            compare_at_restore(expected, catalog(expired=False, live=False, observed=True), receipt)

    def test_resurrected_expired_identity_is_rejected(self):
        expected, receipt = self.project()
        with self.assertRaisesRegex(StoreError, 'COMPLETE_NATIVE_CELLS_CHANGED'):
            compare_at_restore(expected, catalog(observed=True), receipt)

    def test_changed_schema_value_or_writetime_is_rejected(self):
        expected, receipt = self.project()
        for kind in ('schema', 'value', 'writetime'):
            with self.subTest(kind=kind):
                actual = catalog(expired=False, observed=True)
                if kind == 'schema':
                    actual['logical']['schemaCql'] += ' changed'
                else:
                    table = actual['logical']['tables']['edgestore']; row = cell('permanent', value='changed' if kind == 'value' else 'synthetic value', written=124 if kind == 'writetime' else 123)
                    table.update(entries=[row], typedBytes=row[2], sha256=digest([row]))
                    actual['typedBytes'] = sum(t['typedBytes'] for t in actual['logical']['tables'].values())
                actual['logicalSha256'] = digest(actual['logical'])
                with self.assertRaisesRegex(StoreError, 'COMPLETE_NATIVE_CELLS_CHANGED'):
                    compare_at_restore(expected, actual, receipt)

    def test_changed_live_expiry_is_rejected(self):
        expected, receipt = self.project(); actual = catalog(expired=False, observed=True)
        actual['expirations']['txlog'][0][1:3] = [21000, 21001]
        with self.assertRaisesRegex(StoreError, 'EXPIRY_CLOCK_INTERVALS_DISJOINT'):
            compare_at_restore(expected, actual, receipt)

    def test_ambiguous_expiry_at_exact_upper_boundary_is_rejected(self):
        for instant in (9000, 9001, 9002):
            with self.subTest(instant=instant), self.assertRaisesRegex(StoreError, 'AMBIGUOUS_OR_SHORT_EXPIRY'):
                self.project(observed_at=instant)

    def test_expiry_during_budget_or_at_live_horizon_is_rejected(self):
        for lower, upper in ((NOW + 1, NOW + 2), (13700, 13701)):
            for source in (self.before, self.after):
                row = next(r for r in source['expirations']['txlog'] if r[0] == LIVE[0]); row[1:3] = [lower, upper]
            with self.subTest(lower=lower), self.assertRaisesRegex(StoreError, 'AMBIGUOUS_OR_SHORT_EXPIRY'):
                self.project()

    def test_all_expiring_cells_expired_exact_empty_table(self):
        for source in (self.before, self.after):
            for row in source['expirations']['txlog']:
                row[1:3] = [9000, 9001]
        expected, receipt = self.project()
        result = compare_at_restore(expected, catalog(expired=False, live=False, observed=True), receipt)
        self.assertEqual(result['expiredCellsAbsent'], 2); self.assertEqual(expected['logical']['tables']['txlog']['entries'], [])
        self.assertEqual(expected['rows'], 1)

    def test_catalogue_without_ttl_remains_complete(self):
        self.before = catalog(expired=False, live=False); self.after = copy.deepcopy(self.before)
        expected, receipt = self.project(); actual = catalog(expired=False, live=False, observed=True)
        self.assertEqual(compare_at_restore(expected, actual, receipt)['expiredCellsAbsent'], 0)
        self.assertEqual(expected['logicalSha256'], self.before['logicalSha256'])

    def test_duplicate_or_nonmember_expiry_identity_is_rejected(self):
        for mode in ('duplicate', 'nonmember'):
            with self.subTest(mode=mode):
                bad = copy.deepcopy(self.before)
                if mode == 'duplicate':
                    bad['expirations']['txlog'].append(bad['expirations']['txlog'][0].copy()); bad['expirations']['txlog'].sort()
                else:
                    bad['expirations']['txlog'][0][0] = '0' * 64
                with self.assertRaisesRegex(StoreError, 'EXPIRY_MEMBERSHIP_OR_DUPLICATE'):
                    project_native_cells(bad, self.after, observed_at=NOW, remaining_seconds=100)

    def test_malformed_expiry_and_reversed_bounds_are_rejected(self):
        for bounds in ((9002, 9001, 1), (True, 9001, 1), (9000, float('inf'), 1), (9000, 9001, -1)):
            bad = copy.deepcopy(self.before); bad['expirations']['txlog'][0][1:] = bounds
            with self.subTest(bounds=bounds), self.assertRaisesRegex(StoreError, 'EXPIRY_FORMAT'):
                project_native_cells(bad, self.after, observed_at=NOW, remaining_seconds=100)

    def test_inconsistent_catalogue_counts_or_digests_are_rejected(self):
        for field in ('rows', 'typedBytes', 'tableRows', 'tableDigest', 'logicalDigest'):
            bad = copy.deepcopy(self.before)
            if field in ('rows', 'typedBytes'): bad[field] += 1
            elif field == 'tableRows': bad['logical']['tables']['txlog']['rows'] += 1
            elif field == 'tableDigest': bad['logical']['tables']['txlog']['sha256'] = '0' * 64
            else: bad['logicalSha256'] = '0' * 64
            with self.subTest(field=field), self.assertRaises(StoreError):
                project_native_cells(bad, self.after, observed_at=NOW, remaining_seconds=100)

    def test_duplicate_cell_and_missing_expiry_table_are_rejected(self):
        for mode in ('duplicate-cell', 'missing-table'):
            bad = copy.deepcopy(self.before)
            if mode == 'duplicate-cell': bad['logical']['tables']['txlog']['entries'].append(bad['logical']['tables']['txlog']['entries'][0])
            else: del bad['expirations']['edgestore']
            with self.subTest(mode=mode), self.assertRaises(StoreError):
                project_native_cells(bad, self.after, observed_at=NOW, remaining_seconds=100)

    def test_capture_changes_and_disjoint_intervals_are_rejected(self):
        for mode in ('content', 'expiry'):
            bad = copy.deepcopy(self.after)
            if mode == 'content':
                bad['logical']['schemaCql'] += ' changed'; bad['logicalSha256'] = digest(bad['logical'])
            else: bad['expirations']['txlog'][0][1:3] = [30000, 30001]
            with self.subTest(mode=mode), self.assertRaises(StoreError):
                project_native_cells(self.before, bad, observed_at=NOW, remaining_seconds=100)

    def test_invalid_attempt_clock_or_budget_is_rejected(self):
        for instant, budget in ((float('nan'), 100), (float('inf'), 100), (True, 100), (99, 100), (NOW, 0), (NOW, 21601)):
            with self.subTest(instant=instant, budget=budget), self.assertRaises(StoreError):
                self.project(observed_at=instant, remaining_seconds=budget)

    def test_restore_clock_outside_projection_is_rejected(self):
        expected, receipt = self.project()
        for start, end in ((9999, 10001), (13700, 13701)):
            actual = catalog(expired=False, observed=True); actual.update(clockStart=start, clockEnd=end)
            with self.subTest(start=start), self.assertRaisesRegex(StoreError, 'OBSERVATION_CLOCK'):
                compare_at_restore(expected, actual, receipt)

    def test_strict_comparator_still_rejects_expired_cell_omission(self):
        with self.assertRaisesRegex(StoreError, 'COMPLETE_NATIVE_CELLS_CHANGED'):
            same_cells(self.before, catalog(expired=False))

    def test_strict_horizon_rejects_expired_and_accepts_original_live_interval(self):
        with patch('pg01_graph_restore_layout.time.time', return_value=NOW):
            with self.assertRaisesRegex(StoreError, 'TTL_HORIZON_TOO_SHORT'):
                ttl_horizon(dict(beforeCatalog=self.before), 100)
            self.assertEqual(ttl_horizon(dict(beforeCatalog=catalog(expired=False)), 100), 20000)

    def test_invalid_restore_mode_fails_before_capacity_or_destination_work(self):
        with patch.object(pg01_graph_native_restore, 'available_physical') as capacity, self.assertRaisesRegex(StoreError, 'RESTORE_EXPIRY_MODE'):
            pg01_graph_native_restore.restore(Path('unused'), key_file=Path('unused'), private_directory=Path('unused'), node=Path('unused'), expiry_mode='implicit')
        capacity.assert_not_called()


class GraphRecoveryCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='orbita-expiry-cli-'); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve(); self.archive = self.root / 'archive'; self.archive.mkdir()
        self.key = self.root / 'synthetic.key'; self.key.write_bytes(b'synthetic dispatch fixture')
        self.node = self.root / 'synthetic-node.exe'; self.node.write_bytes(b'not executed')
        self.output = self.root / 'new-private'; self.product = Path(__file__).resolve().parents[2]

    def args(self, kind='graph'):
        return [kind, '--product', str(self.product), '--archive', str(self.archive), '--key-file', str(self.key),
                '--private-directory', str(self.output), '--node', str(self.node)]

    def invoke(self, options, status):
        with patch.object(pg01_graph_native_restore, 'restore', return_value=dict(status=status)) as restore, contextlib.redirect_stdout(io.StringIO()):
            code = recover.main(options)
        return code, restore

    def test_cli_defaults_to_strict_and_keeps_original_success_status(self):
        code, restore = self.invoke(self.args(), 'PASS_INDEPENDENT_NATIVE_GRAPH_RESTORE')
        self.assertEqual(code, 0); self.assertEqual(restore.call_args.kwargs['expiry_mode'], 'strict')

    def test_cli_requires_explicit_temporal_mode_and_distinct_success_status(self):
        code, restore = self.invoke(self.args() + ['--graph-expiry-mode', 'at-restore'], 'PASS_INDEPENDENT_TEMPORAL_NATIVE_GRAPH_RESTORE')
        self.assertEqual(code, 0); self.assertEqual(restore.call_args.kwargs['expiry_mode'], 'at-restore')

    def test_temporal_cli_rejects_strict_status_as_temporal_success(self):
        code, _ = self.invoke(self.args() + ['--graph-expiry-mode', 'at-restore'], 'PASS_INDEPENDENT_NATIVE_GRAPH_RESTORE')
        self.assertEqual(code, 1)

    def test_strict_cli_rejects_temporal_status_as_strict_success(self):
        code, _ = self.invoke(self.args(), 'PASS_INDEPENDENT_TEMPORAL_NATIVE_GRAPH_RESTORE')
        self.assertEqual(code, 1)

    def test_postgres_rejects_either_explicit_graph_expiry_option_before_directory_creation(self):
        for mode in ('strict', 'at-restore'):
            with self.subTest(mode=mode), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
                recover.main(self.args('postgres') + ['--graph-expiry-mode', mode])
            self.assertEqual(caught.exception.code, 2); self.assertFalse(self.output.exists())

    def test_unknown_mode_is_rejected_before_directory_creation(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            recover.main(self.args() + ['--graph-expiry-mode', 'implicit'])
        self.assertEqual(caught.exception.code, 2); self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
