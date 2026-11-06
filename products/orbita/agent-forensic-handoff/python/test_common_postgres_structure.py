"""Whole catalogue and negative parity against the preserved prior SQL reader."""
from pathlib import Path
import hashlib,json,os,unittest
import psycopg
from psycopg import sql
import test_common_postgres_catalog as fixture
from orbita_store.admin import connect_operator

REFERENCE=Path(__file__).parent/'fixtures/store_structure_v1.sql'

class CommonStructure(unittest.TestCase):
    setUpClass=classmethod(fixture.CommonCatalogue.setUpClass.__func__)
    tearDownClass=classmethod(fixture.CommonCatalogue.tearDownClass.__func__)
    setUp=fixture.CommonCatalogue.setUp
    tearDown=fixture.CommonCatalogue.tearDown
    connect=fixture.CommonCatalogue.connect

    def authorize(self,operator,key,family):
        operator.execute('SET SESSION AUTHORIZATION orbita_runtime')
        self.assertEqual(operator.execute('SELECT session_user,current_user').fetchone(),('orbita_runtime','orbita_runtime'))
        operator.execute('SELECT orbita_common.authorize_workspace(%s::uuid,%s,true)',(self.binding.workspace_id,self.binding.capability))
        operator.execute('SELECT orbita_common.open_store(%s,%s,false)',(key,family))

    def test_all_installed_families_match_historical_reader_with_actual_runtime(self):
        with connect_operator(self.operator) as operator:
            families=[r[0] for r in operator.execute("SELECT DISTINCT family FROM orbita_private.schema_catalog WHERE kind='table' ORDER BY family")]
            self.assertTrue(set(self.manifest['families']).issubset(families));self.assertIn('case',families)
            installed=operator.execute("SELECT pg_get_functiondef('orbita_common.store_structure()'::regprocedure)").fetchone()[0]
            expected={}
            for family in families:
                db=self.connect(family,'parity/'+family)
                self.assertEqual(db.raw.execute('SELECT session_user,current_user').fetchone(),('orbita_runtime','orbita_runtime'))
                db.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
                try:expected[family]=db.raw.execute('SELECT orbita_common.store_structure()').fetchone()[0]
                finally:db.raw.rollback();db.close()
            operator.execute('BEGIN')
            try:
                operator.execute(REFERENCE.read_text(encoding='utf8'))
                for family in families:
                    with self.subTest(family=family):
                        self.authorize(operator,'parity/'+family,family)
                        self.assertEqual(operator.execute('SELECT orbita_common.store_structure()').fetchone()[0],expected[family])
                        operator.execute('RESET SESSION AUTHORIZATION')
            finally:operator.rollback();operator.execute('RESET SESSION AUTHORIZATION')
            self.assertEqual(operator.execute("SELECT pg_get_functiondef('orbita_common.store_structure()'::regprocedure)").fetchone()[0],installed)
        report=dict(families=families,count=len(families),referenceSha256=hashlib.sha256(REFERENCE.read_bytes()).hexdigest(),actualRuntimeReadOnly=True,wholeStructuresEqual=True)
        (Path(os.environ['ORBITA_POSTGRES_TEST_RECEIPTS'])/'STRUCTURE-FAMILY-PARITY.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')

    def test_schema_changes_corruption_and_first_failure_match_historical_reader(self):
        db=self.connect('semantic','negative/semantic');shape=db.raw.execute('SELECT orbita_common.store_structure()').fetchone()[0];db.close()
        names=[t['name'] for t in shape['tables']];self.assertGreaterEqual(len(names),2)
        first,second=names[:2];relation=sql.Identifier('orbita_semantic',first);other=sql.Identifier('orbita_semantic',second)
        with connect_operator(self.operator) as operator:
            installed=operator.execute("SELECT pg_get_functiondef('orbita_common.store_structure()'::regprocedure)").fetchone()[0]
            primary=operator.execute("SELECT conname FROM pg_constraint WHERE conrelid=%s::regclass AND contype='p'",('orbita_semantic.'+first,)).fetchone()[0]
            custom=operator.execute("SELECT name,definition->>'table' FROM orbita_private.schema_catalog WHERE family='semantic' AND kind='trigger' ORDER BY name LIMIT 1").fetchone();self.assertIsNotNone(custom)
            cases=[
                ('disabled-rowid',[sql.SQL('ALTER TABLE {} DISABLE TRIGGER orbita_assign_rowid').format(relation)],'ORBITA_PG_RELATION_CONSTRAINT_INVALID'),
                ('disabled-receipt',[sql.SQL('ALTER TABLE {} DISABLE TRIGGER orbita_remember_insert').format(relation)],'ORBITA_PG_RELATION_CONSTRAINT_INVALID'),
                ('disabled-custom',[sql.SQL('ALTER TABLE {} DISABLE TRIGGER {}').format(sql.Identifier('orbita_semantic',custom[1]),sql.Identifier(custom[0]))],'ORBITA_PG_RELATION_CONSTRAINT_INVALID'),
                ('rls-off',[sql.SQL('ALTER TABLE {} DISABLE ROW LEVEL SECURITY').format(relation)],'ORBITA_PG_RELATION_SCOPE_INVALID'),
                ('force-off',[sql.SQL('ALTER TABLE {} NO FORCE ROW LEVEL SECURITY').format(relation)],'ORBITA_PG_RELATION_SCOPE_INVALID'),
                ('missing-primary',[sql.SQL('ALTER TABLE {} DROP CONSTRAINT {} CASCADE').format(relation,sql.Identifier(primary))],'ORBITA_PG_RELATION_CONSTRAINT_INVALID'),
                ('unvalidated',[sql.SQL('ALTER TABLE {} ADD CONSTRAINT structure_unvalidated CHECK(rowid>0) NOT VALID').format(relation)],'ORBITA_PG_RELATION_CONSTRAINT_INVALID'),
                ('missing-table',[sql.SQL('ALTER TABLE {} RENAME TO structure_temporarily_missing').format(relation)],'ORBITA_PG_RELATION_SCOPE_INVALID'),
                ('first-constraint-before-scope',[sql.SQL('ALTER TABLE {} DISABLE TRIGGER orbita_assign_rowid').format(relation),sql.SQL('ALTER TABLE {} DISABLE ROW LEVEL SECURITY').format(other)],'ORBITA_PG_RELATION_CONSTRAINT_INVALID'),
                ('fresh-column',[sql.SQL('ALTER TABLE {} ADD COLUMN structure_fresh text').format(relation)],None),
                ('fresh-generated',[sql.SQL('ALTER TABLE {} ADD COLUMN structure_generated bigint GENERATED ALWAYS AS (rowid+1) STORED').format(relation)],None),
            ]
            for label,changes,wanted in cases:
                with self.subTest(case=label):
                    operator.execute('BEGIN')
                    try:
                        for statement in changes:operator.execute(statement)
                        observed=[]
                        for definition in (REFERENCE.read_text(encoding='utf8'),installed):
                            operator.execute(definition);self.authorize(operator,'negative/semantic','semantic')
                            try:
                                with operator.transaction():outcome=operator.execute('SELECT orbita_common.store_structure()').fetchone()[0]
                            except psycopg.Error as error:outcome=error.diag.message_primary
                            operator.execute('RESET SESSION AUTHORIZATION');observed.append(outcome)
                        self.assertEqual(observed[0],observed[1])
                        if wanted:self.assertEqual(observed[1],wanted)
                        else:
                            self.assertIsInstance(observed[1],dict)
                            self.assertNotEqual(observed[1],shape)
                    finally:operator.rollback();operator.execute('RESET SESSION AUTHORIZATION')
                    self.assertEqual(operator.execute("SELECT pg_get_functiondef('orbita_common.store_structure()'::regprocedure)").fetchone()[0],installed)

if __name__=='__main__':unittest.main()
