"""A10 literal-coordinate invariants. Synthetic sources, no model/provider calls."""
import copy
import hashlib
import tempfile
import unittest
from pathlib import Path

from afh_semantic.host import AFHMemory, compile_act, ref, witness
from afh_semantic.knowledge_records import RecordError


def source(identifier, text):
    sha = hashlib.sha256(text.encode('utf8')).hexdigest()
    return dict(id=identifier, revision=sha, payload_sha256=sha,
                representation_id=identifier, occurrence_id='occ-' + identifier,
                source_conversation_id='synthetic-' + identifier, text=text,
                text_sha256=sha, record_sha256=sha, role='user', verified=True,
                coordinate_space='AFH-representation-text-v1')


class QuoteLocatorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.sources = [source('overlap', 'aaaa'), source('unicode', '😀·e\u0301|aaa|aaa'),
                        source('unique', 'Una cita única al final.')]
        self.memory = AFHMemory(self.root, self.sources, 'synthetic', register=True)

    def tearDown(self):
        self.memory.close()
        self.tmp.cleanup()

    def test_overlapping_matches_are_ambiguous_without_start(self):
        with self.assertRaisesRegex(RecordError, 'QUOTE_AMBIGUOUS_OR_MISSING'):
            ref(self.memory, 'overlap', 'aaa')

    def test_explicit_first_and_second_overlapping_matches(self):
        for start in (0, 1):
            with self.subTest(start=start):
                result = ref(self.memory, 'overlap', 'aaa', start)
                self.assertEqual((result['locator']['start'], result['locator']['end']), (start, start + 3))
                self.assertEqual(result['quote'], 'aaa')

    def test_repeated_unicode_quote_uses_full_source_codepoints(self):
        with self.assertRaisesRegex(RecordError, 'QUOTE_AMBIGUOUS_OR_MISSING'):
            ref(self.memory, 'unicode', 'aaa', None)
        result = ref(self.memory, 'unicode', 'aaa', 9)
        self.assertEqual(result['locator'], dict(coordinate_system='unicode_codepoints',
            source_encoding='AFH-representation-text-v1', decoder_version='afh-evidence-text-v1', start=9, end=12))
        self.assertEqual(result['revision'], self.sources[1]['revision'])
        with self.assertRaisesRegex(RecordError, 'QUOTE_MISMATCH'):
            ref(self.memory, 'unicode', 'aaa', 10)  # JS UTF-16 index of that occurrence.

    def test_combining_characters_are_not_normalized(self):
        self.assertEqual(ref(self.memory, 'unicode', 'e\u0301')['locator']['start'], 2)
        with self.assertRaisesRegex(RecordError, 'QUOTE_AMBIGUOUS_OR_MISSING'):
            ref(self.memory, 'unicode', 'é')
        with self.assertRaisesRegex(RecordError, 'QUOTE_MISMATCH'):
            ref(self.memory, 'unicode', 'é', 2)

    def test_full_source_final_character_and_legacy_unique_witness(self):
        text = self.sources[2]['text']
        self.assertEqual(ref(self.memory, 'unique', text)['locator']['end'], len(text))
        self.assertEqual(ref(self.memory, 'unique', '.', len(text) - 1)['locator']['end'], len(text))
        old = witness(self.memory, dict(sourceId='unique', quote='única'), 'unique')
        self.assertEqual(old['locator']['start'], text.index('única'))
        self.assertEqual(old['judgment'], 'pending')

    def test_noninteger_and_invalid_ranges_fail_closed(self):
        for start in (True, False, 1.0, '1', -1, 2, 4, 100):
            with self.subTest(start=start), self.assertRaisesRegex(RecordError, 'QUOTE_MISMATCH'):
                ref(self.memory, 'overlap', 'aaa', start)
        for quote in ('', None, 3):
            with self.subTest(quote=quote), self.assertRaisesRegex(RecordError, 'QUOTE_REQUIRED'):
                ref(self.memory, 'overlap', quote, 0)

    def test_selection_and_registered_revision_are_still_required(self):
        with self.assertRaisesRegex(RecordError, 'AFH_SOURCE_NOT_SELECTED'):
            ref(self.memory, 'outside', 'aaa', 0)
        changed = source('unicode', '😀·e\u0301|aaa|bbb')
        other = AFHMemory(self.root, [changed], 'synthetic', register=False)
        try:
            with self.assertRaisesRegex(RecordError, 'AFH_REGISTRY_CORRUPT'):
                ref(other, 'unicode', 'aaa', 5)
        finally:
            other.close()

    def draft(self):
        evidence = [dict(sourceId='unicode', quote='aaa', start=9)]
        return dict(key='literal', targetSourceId='overlap', type='fact', summary='aaa', modality='stated', clauses=[
            dict(key='literal', quote='aaa', start=1, predicate='literal', polarity='positive', resolution='resolved',
                 arguments=[dict(role='literal_content', literal='aaa', interpreted='', evidence=copy.deepcopy(evidence))],
                 conditions=[dict(literal='aaa', scope='synthetic', resolution='resolved', evidence=copy.deepcopy(evidence))],
                 temporal=[dict(dimension='event', status='unknown', literal='aaa', value='', evidence=copy.deepcopy(evidence))],
                 relations=[dict(kind='compatible', targetClauseVersionId='cv-synthetic-candidate', evidence=copy.deepcopy(evidence))])])

    def test_all_nested_witnesses_and_clause_keep_explicit_positions(self):
        payload = compile_act(self.memory, self.draft(), 'synthetic', 'cut')
        clause = payload['semantic_unit']['clauses'][0]
        self.assertEqual(clause['target_ref']['locator']['start'], 1)
        for pointer, values in clause['evidence_by_field'].items():
            for value in values:
                self.assertEqual(value['locator']['start'], 9 if pointer.startswith(('/arguments/', '/conditions/', '/temporal/', '/relations/')) else 1)
                self.assertEqual(value['judgment'], 'pending')
        self.assertEqual(clause['dependencies'][0]['source_ref']['locator']['start'], 9)
        self.assertEqual(payload['status'], 'proposed')

    def test_every_nested_field_rejects_a_wrong_range(self):
        for field in ('arguments', 'conditions', 'temporal', 'relations'):
            draft = self.draft()
            draft['clauses'][0][field][0]['evidence'][0]['start'] = 10
            with self.subTest(field=field), self.assertRaisesRegex(RecordError, 'QUOTE_MISMATCH'):
                compile_act(self.memory, draft, 'synthetic', 'cut')

    def test_default_literal_argument_uses_explicit_clause_range(self):
        draft = self.draft()
        clause = draft['clauses'][0]
        for field in ('arguments', 'conditions', 'temporal', 'relations'):
            clause[field] = []
        result = compile_act(self.memory, draft, 'synthetic', 'cut')['semantic_unit']['clauses'][0]
        self.assertEqual(result['arguments'][0]['literal'], 'aaa')
        self.assertEqual(result['evidence_by_field']['/arguments/0/literal'][0]['locator']['start'], 1)


if __name__ == '__main__':
    unittest.main()
