import unittest
import test_context_retrieval as fixtures
from afh_semantic.knowledge_records import RecordError

class ContextHistoryTest(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.ContextRetrievalTest(methodName='runTest');self.f.setUp();self.addCleanup(self.f.doCleanups)
        version=self.f.add(0);self.query=self.f.query();self.item=self.query['items'][0]
        self.target=dict(kind='semantic',id=self.item['recordId'],version=self.item['recordVersion'],clauseVersionId=version)
    def read(self,**kwargs):
        return self.f.call('context_history',target=kwargs.get('target',self.target),knownAt=kwargs.get('knownAt',self.query['contextCut']['knownAt']))
    def test_exact_semantic_history_keeps_original_payload(self):
        result=self.read();self.assertEqual(len(result['items']),1);self.assertEqual(result['items'][0]['record'],self.f.records[0])
    def test_clause_from_another_version_is_rejected(self):
        with self.assertRaisesRegex(RecordError,'EXPLORER_CLAUSE_BINDING'):self.read(target={**self.target,'clauseVersionId':'unrelated-clause'})
    def test_cut_before_record_cannot_recover_later_interpretation(self):
        with self.assertRaisesRegex(RecordError,'EXPLORER_HISTORY_CUT'):self.read(knownAt='2000-01-01T00:00:00Z')
    def test_history_target_kinds_are_closed(self):
        with self.assertRaisesRegex(RecordError,'EXPLORER_HISTORY_KIND'):self.read(target={**self.target,'kind':'arbitrary-folder'})

if __name__=='__main__':unittest.main()
