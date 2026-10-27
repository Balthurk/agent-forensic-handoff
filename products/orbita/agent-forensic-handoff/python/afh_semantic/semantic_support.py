# Selected Noetis support-receipt validators; host integration is AFH-owned.
import copy, hashlib
from .sqlite_runtime import serialize, PackageInputError
RECEIPT_KIND = 'n04.semantic-support-review.v1'

def _pointer(value, pointer):
    if not isinstance(pointer, str) or not pointer.startswith('/'):
        raise PackageInputError('SEMANTIC_REVIEW_POINTER_INVALID')
    try:
        for part in pointer.split('/')[1:]:
            part = part.replace('~1', '/').replace('~0', '~')
            if isinstance(value, list):
                if not part.isascii() or not part.isdecimal() or str(int(part)) != part:
                    raise ValueError('noncanonical list index')
                value = value[int(part)]
            else:
                value = value[part]
    except (KeyError, IndexError, TypeError, ValueError) as error:
        raise PackageInputError('SEMANTIC_REVIEW_POINTER_INVALID') from error
    return copy.deepcopy(value)

def _digest(value):
    return hashlib.sha256(serialize(value)).hexdigest()

def _same_json(left, right):
    """Exact canonical typed JSON: int, float and bool must not coerce equal."""
    return serialize(left) == serialize(right)

def validate_review_receipt(packet, raw, *, receipt_sha256, reviewer_task_id, producer_task_id):
    """Check a coordinator-selected independent review artifact; never judge meaning.

    Caller-selected digest/identity are the trust boundary. They must come from
    the independent review delivery, not the extractor or record payload. Local
    actor declarations and hashes do not authenticate people or isolate an OS.
    """
    import json
    from .knowledge_records import RecordError
    def require(ok, code):
        if not ok:
            raise RecordError(code)
    require(isinstance(raw, str) and hashlib.sha256(raw.encode('utf-8')).hexdigest() == receipt_sha256,
            'SUPPORT_RECEIPT_HASH')
    require(len(raw.encode('utf-8')) <= 65536, 'SUPPORT_RECEIPT_BUDGET')
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate JSON member')
            result[key] = value
        return result
    def invalid_constant(value):
        raise ValueError('nonfinite JSON')
    try:
        receipt = json.loads(raw, object_pairs_hook=unique_object, parse_constant=invalid_constant)
    except (ValueError, TypeError) as error:
        raise RecordError('SUPPORT_RECEIPT_SHAPE') from error
    require(isinstance(receipt, dict) and receipt.get('kind') == RECEIPT_KIND, 'SUPPORT_RECEIPT_SHAPE')
    reviewer = receipt.get('reviewer', {})
    require(isinstance(reviewer, dict) and isinstance(reviewer_task_id, str) and bool(reviewer_task_id)
            and isinstance(producer_task_id, str) and bool(producer_task_id)
            and reviewer.get('task_id') == reviewer_task_id
            and reviewer_task_id != producer_task_id
            and reviewer_task_id != packet['content']['administrative_actor'].get('id')
            and reviewer.get('method') == 'independent_technical_review', 'SUPPORT_REVIEWER_INDEPENDENCE')
    require(packet.get('request_sha256') == _digest(packet['content'])
            and receipt.get('request_sha256') == packet['request_sha256']
            and _same_json(receipt.get('binding'), packet['content']['binding']), 'SUPPORT_RECEIPT_BINDING')
    values = receipt.get('fields')
    require(isinstance(values, list) and len(values) == len(packet['content']['fields']), 'SUPPORT_FIELD_COVERAGE')
    expected = {f['field_pointer']: f for f in packet['content']['fields']}
    decisions = {}
    for field in values:
        require(isinstance(field, dict), 'SUPPORT_RECEIPT_SHAPE')
        pointer = field.get('field_pointer')
        require(isinstance(pointer, str) and pointer in expected and pointer not in decisions, 'SUPPORT_FIELD_COVERAGE')
        require(field.get('judgment') in ('supported','contradicts','near_match','insufficient','pending')
                and isinstance(field.get('reason'), str) and bool(field['reason'].strip()), 'SUPPORT_RECEIPT_SHAPE')
        require(_same_json(field.get('evidence'), expected[pointer]['evidence']), 'SUPPORT_FIELD_EVIDENCE')
        require(expected[pointer].get('policy_error') is None or field['judgment'] != 'supported', 'SUPPORT_POLICY_UNCLASSIFIED')
        decisions[pointer] = field
    require(set(decisions) == set(expected), 'SUPPORT_FIELD_COVERAGE')
    return receipt, decisions

def _without_support(clause):
    value = copy.deepcopy(clause)
    value.pop('clause_version_id', None)
    value.pop('applicability', None)
    for witnesses in value['evidence_by_field'].values():
        for witness in witnesses:
            for name in ('judgment','judgment_receipt','reason'):
                witness.pop(name, None)
    return value

def verified_clause_support(records, payload, clause):
    """Resolve committed admission, exact current semantics, and original evidence."""
    from .knowledge_records import RecordError
    payload_hash = _digest(payload)
    admissions = [r for r in getattr(records, '_pending_support_admission', []) if r['payload_sha256']==payload_hash]
    if records.db.execute("SELECT 1 FROM sqlite_master WHERE name='semantic_support_admissions'").fetchone() is not None:
        admissions += [dict(row) for row in records.db.execute(
            'SELECT * FROM semantic_support_admissions WHERE record_id=? ORDER BY version DESC',
            (payload['id'],))]
    for row in admissions:
        import json
        packet = json.loads(row['packet_json'])
        if packet['content']['clause']['semantic_clause_id'] != clause['semantic_clause_id']:
            continue
        if row['payload_sha256'] != payload_hash:
            # Reuse only the ENTIRE immutable supported clause from its sealed
            # committed act version. A changed interpretation/support/version
            # needs a fresh explicit admission, never a borrowed receipt string.
            prior = records.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE record_id=? AND version=?',
                (row['record_id'],row['version'])).fetchone()
            if prior is None or prior['payload_sha256'] != row['payload_sha256']:
                raise RecordError('SUPPORT_RECEIPT_BINDING')
            if hashlib.sha256(prior['payload'].encode('utf-8')).hexdigest() != row['payload_sha256']:
                raise RecordError('RECORD_CORRUPT')
            seal = records.db.execute('SELECT digest FROM record_envelopes WHERE record_rowid=?',(prior['_rowid'],)).fetchone()
            if seal is None or seal['digest'] != records._envelope_digest(prior):
                raise RecordError('RECORD_CORRUPT')
            committed = json.loads(prior['payload'])
            if not any(_same_json(c, clause) for c in committed['semantic_unit']['clauses']):
                continue
        receipt, decisions = validate_review_receipt(packet, row['receipt_raw'],
            receipt_sha256=row['receipt_sha256'], reviewer_task_id=row['reviewer_task_id'],
            producer_task_id=row['producer_task_id'])
        unit = payload['semantic_unit']
        binding = packet['content']['binding']
        if (binding['record_id'] != payload['id'] or binding['act_id'] != unit['act_id']
                or binding['query']['project'] != payload['scope']
                or binding.get('interpretation_version') != unit['interpretation_version']
                or row['context_cut_json'] != serialize(unit['context_cut']).decode('utf-8')
                or not _same_json(_without_support(packet['content']['clause']), _without_support(clause))
                or not _same_json(packet['content']['issuer'], unit['issuer'])):
            raise RecordError('SUPPORT_RECEIPT_BINDING')
        for original in packet['content']['originals']:
            reopened = records._source({'id':original['source_id'], 'revision':original['revision']}, payload['scope'])
            if (_digest(reopened['text']) != _digest(original['text'])
                    or hashlib.sha256(reopened['text'].encode('utf-8')).hexdigest() != original['text_sha256']
                    or reopened.get('record_sha256') != original['record_sha256']
                    or reopened.get('role') != original['source_role']):
                raise RecordError('SUPPORT_ORIGINAL_CHANGED')
        for pointer, decision in decisions.items():
            witnesses = clause['evidence_by_field'].get(pointer)
            if not witnesses or any(w.get('judgment') != decision['judgment']
                    or w.get('judgment_receipt') != row['receipt_sha256']
                    or w.get('reason') != decision['reason'] for w in witnesses):
                raise RecordError('SUPPORT_FIELD_EVIDENCE')
        return all(d['judgment'] == 'supported' for d in decisions.values())
    return False