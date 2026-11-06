"""Exact native-cell expectations at the real restore time; no TTL rewriting."""
import hashlib
import math
import re

from orbita_store.config import require
from orbita_store.service_archive import canonical
from pg01_graph_content_catalog import same_cells
from pg01_graph_restore_layout import TABLES


def _digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def _sha(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None


def _clock(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def validate_catalog(catalog):
    """Check the complete observed catalogue before deriving or comparing it."""
    require(isinstance(catalog, dict), 'GRAPH_TEMPORAL_CATALOG_FORMAT')
    require(catalog.get('status') == 'PASS_COMPLETE_READ_ONLY_CASSANDRA_CELLS', 'GRAPH_TEMPORAL_CATALOG_STATUS')
    logical = catalog.get('logical')
    require(isinstance(logical, dict) and set(logical) == {'format', 'keyspace', 'schemaCql', 'partitioner', 'tables'}, 'GRAPH_TEMPORAL_LOGICAL_FORMAT')
    require(logical['format'] == 'orbita-cassandra-full-cells-1' and logical['keyspace'] == 'orbita_f30', 'GRAPH_TEMPORAL_LOGICAL_FORMAT')
    require(isinstance(logical['schemaCql'], str) and logical['partitioner'] == 'org.apache.cassandra.dht.Murmur3Partitioner', 'GRAPH_TEMPORAL_SCHEMA_FORMAT')
    tables = logical['tables']; expirations = catalog.get('expirations')
    require(isinstance(tables, dict) and sorted(tables) == TABLES, 'GRAPH_TEMPORAL_TABLE_SET')
    require(isinstance(expirations, dict) and set(expirations) == set(tables), 'GRAPH_TEMPORAL_EXPIRY_TABLE_SET')
    rows = typed_bytes = 0
    for name, table in tables.items():
        require(isinstance(table, dict) and set(table) == {'rows', 'typedBytes', 'entries', 'sha256'}, 'GRAPH_TEMPORAL_TABLE_FORMAT')
        entries = table['entries']; require(isinstance(entries, list), 'GRAPH_TEMPORAL_ENTRIES_FORMAT')
        identities = set(); previous = ''; size = 0
        for entry in entries:
            require(isinstance(entry, list) and len(entry) == 3 and _sha(entry[0]) and _sha(entry[1]) and type(entry[2]) is int and entry[2] > 0, 'GRAPH_TEMPORAL_CELL_FORMAT')
            require(entry[0] > previous, 'GRAPH_TEMPORAL_CELL_ORDER_OR_DUPLICATE')
            previous = entry[0]; identities.add(entry[0]); size += entry[2]
        require(type(table['rows']) is int and table['rows'] == len(entries) and type(table['typedBytes']) is int and table['typedBytes'] == size, 'GRAPH_TEMPORAL_TABLE_COUNTS')
        require(table['sha256'] == _digest(entries), 'GRAPH_TEMPORAL_TABLE_DIGEST')
        expiry = expirations[name]; require(isinstance(expiry, list), 'GRAPH_TEMPORAL_EXPIRY_FORMAT'); previous = ''
        for entry in expiry:
            require(isinstance(entry, list) and len(entry) == 4 and _sha(entry[0]) and all(type(v) is int and v >= 0 for v in entry[1:]) and entry[1] <= entry[2], 'GRAPH_TEMPORAL_EXPIRY_FORMAT')
            require(entry[0] > previous and entry[0] in identities, 'GRAPH_TEMPORAL_EXPIRY_MEMBERSHIP_OR_DUPLICATE')
            previous = entry[0]
        rows += len(entries); typed_bytes += size
    require(rows <= 1000000 and typed_bytes <= 1024**3, 'GRAPH_TEMPORAL_CATALOG_BUDGET')
    require(type(catalog.get('rows')) is int and catalog['rows'] == rows and type(catalog.get('typedBytes')) is int and catalog['typedBytes'] == typed_bytes, 'GRAPH_TEMPORAL_CATALOG_COUNTS')
    require(catalog.get('logicalSha256') == _digest(logical), 'GRAPH_TEMPORAL_LOGICAL_DIGEST')
    require(_clock(catalog.get('clockStart')) and _clock(catalog.get('clockEnd')) and catalog['clockStart'] <= catalog['clockEnd'], 'GRAPH_TEMPORAL_CATALOG_CLOCK')


def project_native_cells(before, after, *, observed_at, remaining_seconds):
    """Remove only identities certainly expired before this actual attempt.

    Future expirations must survive the entire remaining budget plus one hour.
    An interval containing the observation, or intersecting that budget, fails.
    The captured catalogues are never mutated and are not relabelled as restored.
    """
    require(_clock(observed_at) and _clock(remaining_seconds) and 0 < remaining_seconds <= 21600, 'GRAPH_TEMPORAL_RESTORE_CLOCK')
    validate_catalog(before); validate_catalog(after)
    require(max(before['clockEnd'], after['clockEnd']) <= observed_at, 'GRAPH_TEMPORAL_CAPTURE_IN_FUTURE')
    captured = same_cells(before, after)
    horizon = observed_at + remaining_seconds + 3600
    expired = {}; retained = {}; tables = {}; expirations = {}
    for name, table in before['logical']['tables'].items():
        expired[name] = []; retained[name] = []
        for identity, low, high in captured['expiryIntersections'][name]:
            if high < observed_at:
                expired[name].append([identity, low, high])
            else:
                require(low > horizon, 'GRAPH_TEMPORAL_AMBIGUOUS_OR_SHORT_EXPIRY')
                retained[name].append([identity, low, high])
        removed = {entry[0] for entry in expired[name]}
        entries = [entry for entry in table['entries'] if entry[0] not in removed] if removed else table['entries']
        tables[name] = dict(rows=len(entries), typedBytes=sum(entry[2] for entry in entries), entries=entries, sha256=_digest(entries)) if removed else table
        expirations[name] = retained[name]
    logical = dict(before['logical'], tables=tables)
    expected = dict(status='EXPECTED_NATIVE_CELLS_AT_RESTORE_NOT_OBSERVED', logical=logical, logicalSha256=_digest(logical), expirations=expirations,
                    rows=sum(t['rows'] for t in tables.values()), typedBytes=sum(t['typedBytes'] for t in tables.values()))
    expired_count = sum(map(len, expired.values())); live_count = sum(map(len, retained.values()))
    require(expected['rows'] + expired_count == before['rows'], 'GRAPH_TEMPORAL_PROJECTION_COUNT')
    receipt = dict(status='EXPECTED_NATIVE_CELLS_AT_RESTORE_NOT_OBSERVED', mode='at-restore', observedAtUnixSeconds=observed_at,
                   remainingSeconds=remaining_seconds, requiredLiveUntilUnixSeconds=horizon, safetyMarginSeconds=3600,
                   capturedLogicalSha256=before['logicalSha256'], expectedLogicalSha256=expected['logicalSha256'], capturedRows=before['rows'],
                   expectedRows=expected['rows'], expiredCells=expired_count, retainedExpiringCells=live_count,
                   unchangedPermanentCells=before['rows'] - expired_count - live_count, expired=expired, retainedExpiring=retained,
                   archiveOrClockModified=False, ttlReset=False, humanAcceptance=False)
    return expected, receipt


def compare_at_restore(expected, restored, projection):
    """Require every remaining native byte and the exact absence of expired IDs."""
    validate_catalog(restored)
    require(expected['logicalSha256'] == projection['expectedLogicalSha256'], 'GRAPH_TEMPORAL_PROJECTION_BINDING')
    require(projection['observedAtUnixSeconds'] <= restored['clockStart'] <= restored['clockEnd'] < projection['requiredLiveUntilUnixSeconds'], 'GRAPH_TEMPORAL_OBSERVATION_CLOCK')
    parity = same_cells(expected, restored)
    return dict(parity, status='PASS_EXACT_NATIVE_CELLS_AT_RESTORE', mode='at-restore', expiredCellsAbsent=projection['expiredCells'],
                capturedLogicalSha256=projection['capturedLogicalSha256'], observedLogicalSha256=restored['logicalSha256'],
                capturedNativeCellsEqual=projection['expiredCells'] == 0)
