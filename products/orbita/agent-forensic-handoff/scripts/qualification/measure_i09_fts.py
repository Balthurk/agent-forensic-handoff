"""C04 experiment only: native GIN preselection followed by the exact matcher.

No runtime imports this module. All documents are generated below. Prototype
tables are session-local PostgreSQL TEMP tables under the test operator: they
are not a proposed permission model or a migration of any product table.
"""
from pathlib import Path
import argparse, contextlib, hashlib, json, statistics, sys, time, unittest

PYTHON = Path(__file__).resolve().parents[2] / 'python'
sys.path.insert(0, str(PYTHON))
from orbita_store import fts
from orbita_store.admin import connect_operator
from orbita_store.pool import close_idle
from test_common_postgres_fts import CommonFullText


def measured(call):
    wall, cpu = time.perf_counter(), time.process_time()
    value = call()
    return value, dict(seconds=time.perf_counter()-wall, clientCpuSeconds=time.process_time()-cpu)


def native_predicate(tree):
    """Preserve Boolean structure and phrase column boundaries, not token parity."""
    op = tree[0]
    if op == 'phrase':
        if not tree[1]:
            return 'FALSE', []
        phrase = ' '.join(tree[1])
        return '('+' OR '.join(c+" @@ phraseto_tsquery('simple',%s)" for c in ('vk','vi','vo'))+')', [phrase]*3
    left, a = native_predicate(tree[1])
    right, b = native_predicate(tree[2])
    return '('+left+(' AND NOT ' if op == 'NOT' else ' '+op+' ')+right+')', a+b


class Prototype:
    def __init__(self, raw, rows, mode):
        assert mode in ('native_raw', 'unicode61_preprocessed')
        self.raw, self.table, self.mode = raw, 'i09_'+mode, mode
        raw.execute("SET statement_timeout='30s'")
        raw.execute('CREATE TEMP TABLE '+self.table+'(event_id text PRIMARY KEY,kind text,input_preview text,output_preview text,vk tsvector,vi tsvector,vo tsvector)')
        def publish():
            values=[]
            for row in rows:
                indexed=row[1:]
                if mode == 'unicode61_preprocessed':
                    indexed=tuple(' '.join(fts.tokens(value)) for value in indexed)
                values.append((*row,*indexed))
            with raw.cursor() as cur:
                cur.executemany('INSERT INTO '+self.table+" VALUES(%s,%s,%s,%s,to_tsvector('simple',coalesce(%s,'')),to_tsvector('simple',coalesce(%s,'')),to_tsvector('simple',coalesce(%s,'')))", values)
        _, self.publish = measured(publish)
        def indexes():
            for column in ('vk','vi','vo'):
                raw.execute('CREATE INDEX ON '+self.table+' USING gin('+column+')')
            raw.execute('ANALYZE '+self.table)
        _, self.index = measured(indexes)
        self.bytes = raw.execute('SELECT pg_total_relation_size(%s::regclass)', (self.table,)).fetchone()[0]

    def query(self, query, *, explain=False):
        tree=fts.compile_query(query)
        predicate, params=native_predicate(tree)
        statement='SELECT event_id,kind,input_preview,output_preview FROM '+self.table+' WHERE '+predicate+' ORDER BY event_id'
        if explain:
            return self.raw.execute('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+statement, params).fetchone()[0]
        # Preselection and exact refinement run while this same RR transaction
        # remains open; no ranking, limit or offset is applied before refinement.
        with self.raw.transaction():
            self.raw.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            budget=fts.Budget(fts.Limits());ids=[];count=0
            with self.raw.cursor(name='i09_preselection') as cursor:
                cursor.execute(statement, params)
                while rows:=cursor.fetchmany(64):
                    for row in rows:
                        count+=1;budget.take(sum(len(v.encode()) for v in row[1:] if v))
                        if fts.matches(tree,tuple(fts.tokens(v,budget.check) for v in row[1:])):ids.append(row[0])
            budget.check()
        return ids, count


@contextlib.contextmanager
def fixture():
    value=CommonFullText('test_alias_filters_order_limit_and_unindexed_columns')
    value.setUp()
    try:
        yield value
    finally:
        value.tearDown()
        close_idle()


def current_query(db, query):
    return [r[0] for r in db.execute('SELECT event_id FROM event_fts WHERE event_fts MATCH ? ORDER BY event_id', (query,))]


def parity():
    longword='z'*4096
    rows=[('a','kind','Éxito alfa_beta revisión',None),('b','kind','alpha beta gamma','delta'),
          ('c','kind','alpha','beta'),('d','kind','a\u0301b CAFÉ Straße Łódź ộ',None),
          ('e','kind','😀\ue000 \U00010400 Œuvre','quote "two words"'),
          ('f','kind',longword,None),('g','kind','alpha beta',None),
          ('secret-only','kind','unrelated',None)]
    queries=['"exito"','"alfa_beta"','"alpha beta"','"alpha" AND "beta"','"alpha" NOT "gamma"',
             '("alpha" OR "cafe") AND "kind"','"ab"','"straße"','"Łódź"','"ộ"','"😀\ue000"',
             '"quote ""two words"""','alpha beta NOT gamma','""','alpha\u00a0beta',
             '"secret-only"',longword,'alpha OR delta','(alpha OR delta) NOT gamma']
    result=[]
    with fixture() as f, connect_operator(f.operator) as raw:
        db=f.populate(rows)
        prototypes=[Prototype(raw,rows,mode) for mode in ('native_raw','unicode61_preprocessed')]
        for query in queries:
            exact=current_query(db,query)
            for candidate in prototypes:
                ids,count=candidate.query(query)
                result.append(dict(mode=candidate.mode,query=query if len(query)<128 else '<4096-character ASCII token>',
                    querySha256=hashlib.sha256(query.encode()).hexdigest(),expectedIds=exact,actualIds=ids,
                    preselectedRows=count,falseNegatives=sorted(set(exact)-set(ids)),falsePositives=sorted(set(ids)-set(exact)),
                    exactOrderedEquality=ids==exact))
    return result


def load_rows(n):
    return [(f'doc-{i:06d}','event',
             ('rarekey alpha beta ' if i%97==0 else 'routine alpha gamma ')+
             ('CAFÉ revisión Straße ' if i%11==0 else 'conservar originales y evidencia ')+
             'texto sintético de publicación y consulta. '*3,
             'delta reviewed' if i%13==0 else None) for i in range(n)]


def load_case(n):
    rows=load_rows(n)
    queries=['rarekey','"alpha beta"','alpha NOT gamma','"cafe"','alpha OR delta']
    with fixture() as f, connect_operator(f.operator) as raw:
        db=f.connect('case')
        _,publication=measured(lambda:db.executemany('INSERT INTO event_fts VALUES(?,?,?,?)',rows))
        candidates=[Prototype(raw,rows,mode) for mode in ('native_raw','unicode61_preprocessed')]
        results=[]
        for query in queries:
            # Warm each path once. Measurements alternate order across repeats.
            expected=current_query(db,query)
            for candidate in candidates:candidate.query(query)
            samples={key:[] for key in ['current',*(c.mode for c in candidates)]}
            outputs={};preselected={}
            for repeat in range(3):
                order=['current',*candidates] if repeat%2==0 else [*reversed(candidates),'current']
                for item in order:
                    if item=='current':
                        ids,timing=measured(lambda:current_query(db,query));key='current'
                    else:
                        (ids,count),timing=measured(lambda:item.query(query));key=item.mode;preselected[key]=count
                    assert ids==outputs.setdefault(key,ids),'NONDETERMINISTIC_RESULT'
                    samples[key].append(timing)
            assert outputs['current']==expected
            results.append(dict(query=query,expectedMatches=len(expected),expectedIdsSha256=hashlib.sha256(json.dumps(expected).encode()).hexdigest(),
                samples=samples,medianSeconds={k:statistics.median(s['seconds'] for s in v) for k,v in samples.items()},
                candidates={c.mode:dict(matches=len(outputs[c.mode]),preselected=preselected[c.mode],
                    exactOrderedEquality=outputs[c.mode]==expected,falseNegativeCount=len(set(expected)-set(outputs[c.mode])),
                    falsePositiveCount=len(set(outputs[c.mode])-set(expected))) for c in candidates}))
        plans={c.mode:c.query('rarekey',explain=True) for c in candidates}
        return dict(rows=n,utf8TextBytes=sum(len(v.encode()) for r in rows for v in r[1:] if v),
            currentPublication=publication,prototypePublication={c.mode:dict(insertAndVectorize=c.publish,indexAndAnalyze=c.index,totalRelationBytes=c.bytes) for c in candidates},
            queries=results,rareTermExplainAnalyze=plans,
            publicationComparisonLimit='Prototype uses one operator TEMP table and no product fences, outbox or RLS; its lower publication cost is not an equivalent deployment claim.')


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    assert not args.output.exists()
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(CommonFullText)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    assert result.wasSuccessful() and result.testsRun==10 and not result.skipped,'CURRENT_FTS_ORACLE_FAILED'
    CommonFullText.setUpClass()
    try:
        matrix=parity()
        loads=[load_case(n) for n in (1000,10000)]
    finally:
        CommonFullText.tearDownClass();close_idle()
    mismatches={m:sum(not r['exactOrderedEquality'] for r in matrix if r['mode']==m) for m in ('native_raw','unicode61_preprocessed')}
    value=dict(schema='orbita.i09.fts-experiment.v1',status='COMPLETE_MEASURED_EXPERIMENT_NOT_OPTIMIZATION_QUALIFICATION',
        currentOracleTests=result.testsRun,parity=matrix,parityMismatches=mismatches,loads=loads,
        decision='DO_NOT_ADOPT_EVALUATED_NATIVE_PRESELECTIONS' if all(mismatches.values()) else 'FURTHER_QUALIFICATION_REQUIRED',
        reason='Exact refinement cannot recover rows excluded by native tokenization or lexeme limits.' if all(mismatches.values()) else 'Parity sample alone is insufficient for migration, replay, recovery and permission qualification.',
        scope='Two simple-config tsvector GIN prototypes, raw text and Unicode61-preprocessed text; Boolean structure and separate phrase columns preserved. Not a claim that every possible GIN design is impossible.',
        workloads='Deterministic synthetic multilingual short texts at1000/10000rows; sparse and broad terms, phrase and Boolean queries, plus private-use Unicode and4096-character token adversaries. Not measured user workload.',
        runtimeChanged=False,indexOrSchemaMigrated=False,permissionsChanged=False,limitsChanged=False,humanAcceptance=False)
    args.output.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print(json.dumps({k:value[k] for k in ['status','currentOracleTests','parityMismatches','decision']},ensure_ascii=False),flush=True)


if __name__=='__main__':main()
