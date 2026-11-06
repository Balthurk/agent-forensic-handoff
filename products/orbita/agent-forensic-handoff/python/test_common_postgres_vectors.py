"""Exact legacy-native float32 oracle; common PG is the runtime under test."""
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch
import hashlib,math,random,sqlite3,struct,unittest

import test_common_postgres_catalog as catalogue_fixture
from orbita_store.connection import Connection
from orbita_store import StoreError,vectors

DLL=Path('C:/T/oi5r1/products/orbita/agent-forensic-handoff/node_modules/sqlite-vec-windows-x64/vec0.dll')
def encoded(values):return struct.pack('<'+str(len(values))+'f',*values)
def oracle():
    assert hashlib.sha256(DLL.read_bytes()).hexdigest()=='fcf98662a7ad9dce394b96a88f91032047823831b951c76636787c312a6476e6'
    db=sqlite3.connect(':memory:');db.enable_load_extension(True);db.load_extension(str(DLL));db.enable_load_extension(False)
    return db

class CommonVectors(unittest.TestCase):
    setUpClass=classmethod(catalogue_fixture.CommonCatalogue.setUpClass.__func__)
    tearDownClass=classmethod(catalogue_fixture.CommonCatalogue.tearDownClass.__func__)
    setUp=catalogue_fixture.CommonCatalogue.setUp
    tearDown=catalogue_fixture.CommonCatalogue.tearDown
    connect=catalogue_fixture.CommonCatalogue.connect

    def seed(self,db,items):
        for start in range(0,len(items),64):
            batch=items[start:start+64];rows=[];index=[]
            for rowid,value in batch:
                raw=encoded(value);rows.extend((rowid,hashlib.sha256(str(rowid).encode()).hexdigest(),raw,hashlib.sha256(raw).hexdigest(),len(value),'now'));index.extend((rowid,raw))
            with db:
                db.execute('INSERT INTO semantic_embedding VALUES '+','.join(['(?,?,?,?,?,?)']*len(batch)),rows)
                db.execute('INSERT INTO vector_index VALUES '+','.join(['(?,?)']*len(batch)),index)

    def test_float32_distances_equal_the_qualified_native_oracle_exactly(self):
        rng=random.Random(731)
        with oracle() as old:
            for dimension in (2,3,7,32,384,768):
                for sample in range(12):
                    a=encoded([rng.uniform(-1,1) for _ in range(dimension)])
                    b=a if sample==0 else encoded([rng.uniform(-1,1) for _ in range(dimension)])
                    expected=old.execute('SELECT vec_distance_cosine(?,?)',(a,b)).fetchone()[0]
                    self.assertEqual(vectors.cosine(vectors.unpack(a),vectors.unpack(b)),expected,(dimension,sample))
            a,b=encoded([1e30,1e30]),encoded([1,0])
            self.assertEqual(vectors.cosine(vectors.unpack(a),vectors.unpack(b)),old.execute('SELECT vec_distance_cosine(?,?)',(a,b)).fetchone()[0])

    def test_knn_ties_across_native_chunks_retain_insertion_order(self):
        # IDs intentionally differ from insertion order; this proves the
        # durable ordinal, not a rowid/ctid shortcut, drives the tie rule.
        items=[(10000-i,[1.0,0.0]) for i in range(2050)];db=self.connect('vector');self.seed(db,items)
        with oracle() as old:
            old.execute('CREATE VIRTUAL TABLE v USING vec0(embedding float[2] distance_metric=cosine)')
            old.executemany('INSERT INTO v(rowid,embedding) VALUES(?,?)',[(i,encoded(v)) for i,v in items])
            for k in (1,7,1024,1030,2050):
                expected=old.execute('SELECT rowid,distance FROM v WHERE embedding MATCH ? ORDER BY distance LIMIT ?',(encoded([1,0]),k)).fetchall()
                self.assertEqual(db.nearest_vectors(encoded([1,0]),k).fetchall(),expected,k)
        db.close();fresh=self.connect('vector')
        self.assertEqual(fresh.nearest_vectors(encoded([1,0]),1).fetchone(),(8977,0.0))
        self.assertEqual(fresh.execute('SELECT * FROM vector_index LIMIT 1').description[0][0],'rowid')
        with self.assertRaisesRegex(StoreError,'RESERVED_COLUMN'):fresh.execute('SELECT _index_ordinal FROM vector_index')

    def test_distances_ranking_original_bytes_and_fresh_reader(self):
        rng=random.Random(728);items=[(i+1,[rng.uniform(-1,1) for _ in range(12)]) for i in range(80)]
        db=self.connect('vector');self.seed(db,items);query=encoded(items[9][1])
        with oracle() as old:
            old.execute('CREATE VIRTUAL TABLE v USING vec0(embedding float[12] distance_metric=cosine)')
            old.executemany('INSERT INTO v(rowid,embedding) VALUES(?,?)',[(i,encoded(v)) for i,v in items])
            expected=old.execute('SELECT rowid,distance FROM v WHERE embedding MATCH ? ORDER BY distance LIMIT 23',(query,)).fetchall()
        db.close();reader=Connection(self.binding.root+'/vector',family='vector',config=self.config,read_only=True);self.connections.append(reader)
        with patch('sqlite3.connect',side_effect=AssertionError('no runtime embedded engine')):
            self.assertEqual(reader.nearest_vectors(query,23).fetchall(),expected)
        self.assertEqual(reader.execute('SELECT vector FROM semantic_embedding WHERE rowid=?',(10,)).fetchone()[0],query)
        self.assertEqual(self.connect('vector','empty').nearest_vectors(query,23).fetchall(),[])

    def test_missing_index_corrupt_hash_and_different_dimensions_fail_closed(self):
        db=self.connect('vector');self.seed(db,[(1,[1,0]),(2,[0,1])])
        for mutation,restore,code in [
            ("UPDATE semantic_embedding SET vector_sha256='bad' WHERE rowid=1",None,'VECTOR_HASH'),
            ('UPDATE semantic_embedding SET dimensions=3 WHERE rowid=1',None,'VECTOR_DIMENSIONS'),
        ]:
            db.execute('BEGIN');db.execute(mutation)
            # Explicit RR scope allows own writes while retaining one snapshot.
            db.rollback()
            db.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ');db.execute(mutation)
            with self.assertRaisesRegex(StoreError,code):db.nearest_vectors(encoded([1,0]),1)
            db.rollback()
        db.execute('DELETE FROM vector_index WHERE rowid=1')
        with self.assertRaisesRegex(StoreError,'VECTOR_ORDER_OR_INDEX_MISSING'):db.nearest_vectors(encoded([1,0]),1)
        self.assertEqual(db.execute('SELECT count(*) FROM semantic_embedding').fetchone(),(2,))

    def test_zero_nonfinite_and_malformed_vectors_never_become_perfect_matches(self):
        db=self.connect('vector');self.seed(db,[(1,[1,0])])
        for value,code in [(encoded([0,0]),'VECTOR_UNDEFINED_COSINE'),(encoded([math.nan,0]),'VECTOR_NONFINITE'),(b'abc','VECTOR_BYTES')]:
            with self.assertRaisesRegex(StoreError,code):db.nearest_vectors(value)
        for k in (0,4097,True):
            with self.assertRaisesRegex(StoreError,'VECTOR_K_LIMIT'):db.nearest_vectors(encoded([1,0]),k)
        with oracle() as old:self.assertIsNone(old.execute('SELECT vec_distance_cosine(?,?)',(encoded([0,0]),encoded([1,0]))).fetchone()[0])
        self.seed(db,[(2,[0,0])])
        with self.assertRaisesRegex(StoreError,'VECTOR_UNDEFINED_COSINE'):db.nearest_vectors(encoded([1,0]),1)

    def test_scan_budget_has_no_partial_output_and_preserves_connection(self):
        db=self.connect('vector');self.seed(db,[(1,[1,0]),(2,[0,1])])
        for limits in (vectors.Limits(rows=1),vectors.Limits(bytes=1),vectors.Limits(seconds=.00001)):
            with self.subTest(limits=limits):
                with self.assertRaisesRegex(StoreError,'VECTOR_(SCAN_BUDGET|DEADLINE)'):db.nearest_vectors(encoded([1,0]),1,limits=limits)
                self.assertFalse(db.in_transaction)
                self.assertEqual(db.execute('SELECT count(*) FROM vector_index').fetchone(),(2,))
        self.assertEqual(len(db.nearest_vectors(encoded([1,0]),2).fetchall()),2)

    def test_snapshot_keeps_original_vectors_when_another_writer_commits(self):
        db=self.connect('vector');self.seed(db,[(1,[1,0]),(2,[0,1])]);writer=self.connect('vector')
        original=vectors.cosine;calls=0
        def concurrent(a,b):
            nonlocal calls
            calls+=1
            if calls==2:
                self.seed(writer,[(3,[-1,0])])
                writer.execute("UPDATE semantic_embedding SET vector_sha256='changed' WHERE rowid=2")
            return original(a,b)
        with patch.object(vectors,'cosine',concurrent):
            self.assertEqual(db.nearest_vectors(encoded([1,0]),3).fetchall(),[(1,0.0),(2,1.0)])
        with self.assertRaisesRegex(StoreError,'VECTOR_HASH'):db.nearest_vectors(encoded([1,0]),3)

    def test_read_committed_caller_is_rejected_without_rollback_or_replay(self):
        db=self.connect('vector');self.seed(db,[(1,[1,0])]);db.execute('BEGIN')
        db.execute("UPDATE semantic_embedding SET created_at='pending'")
        with self.assertRaisesRegex(StoreError,'VECTOR_REPEATABLE_SNAPSHOT_REQUIRED'):db.nearest_vectors(encoded([1,0]))
        self.assertTrue(db.in_transaction);self.assertEqual(db.execute('SELECT created_at FROM semantic_embedding').fetchone(),('pending',));db.rollback()

if __name__=='__main__':unittest.main()
