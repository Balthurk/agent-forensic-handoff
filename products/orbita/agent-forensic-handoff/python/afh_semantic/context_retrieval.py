"""F22: bounded, source-bound context discovery. Similarity is never a relation.

Query snapshots/page budgets are owned by the application. This module returns
complete semantic components and decision alternatives, or explicit blockers.
It neither approves interpretations nor infers missing validity/authority.
"""
import re, unicodedata
from pathlib import Path
from contextlib import contextmanager
from .knowledge_records import KnowledgeRecords, RecordError, _json
from .host import AFHMemory, clause_index, query_records, digest, now, require
from .relational_memory import instant
from .collectives import sql_cut, history as collective_history, public as collective_public
from .decisions import verify_chain, public as decision_public
from .postgres_backend import restrict_sources

STOP = set('que como cual cuales donde cuando para por con una uno unos unas del los las el la de se es en y o mi me sobre esta este esto hay fue han ya mas todo toda todos todas puedes puede quiero saber dime explica segun informacion conversacion conversaciones haz the a an and or what which where when how did does is are was were to of in on for please'.split())

def words(value):
    text = ''.join(c for c in unicodedata.normalize('NFD', str(value).casefold()) if not unicodedata.combining(c))
    return {t for t in re.findall(r'\w+', text) if len(t) > 2 and t not in STOP}

@contextmanager
def store(request, folder=''):
    root = Path(request['root']) / folder
    if not (root / 'records.sqlite3').exists():
        yield None
        return
    memory = AFHMemory(root, request['sources'], request['scope'])
    records = KnowledgeRecords(memory, root / 'records.sqlite3', read_only=True)
    try:
        restrict_sources(records)
        records.db.execute('BEGIN')
        yield records
    finally:
        records.close()
        memory.close()

def heads(records, known, limit=500):
    rows = records.db.execute('''SELECT rowid AS _rowid,* FROM record_versions r
        WHERE scope=? AND recorded_at<=? AND NOT EXISTS
        (SELECT 1 FROM record_versions n WHERE n.scope=r.scope AND n.record_id=r.record_id
         AND n.version>r.version AND n.recorded_at<=?) ORDER BY record_id LIMIT ?''',
        (records.memory.scope, sql_cut(known), sql_cut(known), limit+1)).fetchall()
    require(len(rows) <= limit, 'CONTEXT_HEAD_BUDGET')
    return rows

def source_refs(values):
    return list({(r['id'], r['revision']): r for value in values for r in value}.values())

def semantic(records, request, known, at):
    empty = dict(schema='afh-semantic-context-1', items=[], edges=[], missing=[], limitations=[],
                 requiresAbstention=True, status='not_extracted', coverage='No admitted semantic records')
    if records is None:
        return empty, [], 0
    latest, active, versions, limits = clause_index(records, request['scope'], known)
    require(len(versions) <= 5000, 'SEMANTIC_QUERY_ROW_BUDGET')
    roots = request.get('roots', [])
    require(isinstance(roots, list) and len(roots) <= 100 and all(isinstance(x, str) for x in roots), 'ROOT_BUDGET')
    require(all(x in versions for x in roots), 'ROOT_NOT_AVAILABLE')
    terms = words(request.get('question', ''))
    text = lambda item: _json([item['record']['payload']['text'], item['clause']['predicate'], item['clause']['arguments'], item['clause'].get('conditions', [])])
    selected = set(roots) if roots else {vid for vid, item in active.items() if terms & words(text(item))}
    # Compare potential complements sharing an explicit argument/scope. The
    # match is a discovery hint, not an exception, revocation or entity merge.
    anchors = set()
    for vid in selected:
        c = versions[vid]['clause']
        for arg in c['arguments']:
            if arg['role'] != 'literal_content': anchors.update(words(arg.get('literal', '')))
        for condition in c.get('conditions', []): anchors.update(words(condition.get('ast', {}).get('scope', '')))
    candidates = []
    for vid, item in active.items():
        if vid not in selected and anchors & words(text(item)):
            candidates.append(dict(version=vid, reason='shared_literal_argument_or_scope', relationEstablished=False))
            selected.add(vid)
    require(len(selected) <= 100, 'CONTEXT_SEMANTIC_CANDIDATE_BUDGET')
    all_edges = [dict(fromVersion=vid, **r) for vid, item in versions.items() for r in item['clause'].get('relations', [])]
    edges = []; missing = []; changed = True
    while changed:
        changed = False
        for edge in all_edges:
            a, b = edge['fromVersion'], edge['target_clause_version_id']
            if a not in selected and not (a in active and b in selected): continue
            public = {'from': a, 'to': b, **{k: v for k, v in edge.items() if k != 'fromVersion'}}
            if public not in edges: edges.append(public)
            for vid in (a, b):
                if vid not in versions:
                    gap = dict(version=vid, reason='target_unavailable_at_cut_or_selection')
                    if gap not in missing: missing.append(gap)
                elif vid not in selected:
                    selected.add(vid); changed = True
            require(len(selected) <= 100 and len(edges) <= 500, 'CONTEXT_DEPENDENCY_BUDGET')
    if not selected:
        return {**empty, 'status': 'no_match', 'limitations': limits}, [], len(latest)
    # Reuse the validated rows from this same read transaction. No second
    # database snapshot or cached cross-request permissions are introduced.
    result = query_records(records, dict(request, question='', roots=sorted(selected), hops=0, limit=100, knownAt=known, validAt=at),snapshot_index=(latest,active,versions,limits))
    result.update(edges=edges, missing=missing, limitations=limits, candidateComplements=candidates, status='available')
    for item in result['items']:
        item['sourceCurrency'] = 'historical_revision' if any(records.memory.sources[r['id']].get('document', {}).get('currentRevision') is False for r in item['sourceRefs']) else 'selected_revision'
    result['requiresAbstention'] = bool(missing or limits) or any(i['support'] != 'supported' or i['resolution'] != 'resolved' or i['validity'] != 'inside' or i['sourceCurrency'] != 'selected_revision' for i in result['items'])
    refs = source_refs([i['sourceRefs'] for i in result['items']])
    unit = dict(id='semantic-'+digest(sorted(selected))[:24], kind='semantic', title='Reglas, condiciones y evidencia complementaria',
                sourceRefs=refs, needs=['rule', 'condition', 'exception', 'revocation', 'contradiction', 'antecedent', 'validity', 'scope'],
                requiresReview=result['requiresAbstention'], blocked=bool(missing), data=result)
    return result, [unit], len(latest)

def dispatch_context(request):
    require(isinstance(request.get('question'), str) and 0 < len(request['question']) <= 8000, 'CONTEXT_QUESTION')
    known = request.get('knownAt') or now(); at = request.get('validAt') or known
    instant(known); instant(at)
    mode = 'historical' if request.get('knownAt') else 'current'
    with store(request) as records:
        knowledge, units, extracted = semantic(records, request, known, at)
    blockers = []; outside = 0; scanned = {'semanticRecords': extracted, 'collectives': 0, 'decisions': 0}
    terms = words(request['question'])
    matched_sources = {r['id'] for u in units for r in u['sourceRefs']}
    for folder in ('collectives', 'decisions'):
        with store(request, folder) as records:
            if records is None: continue
            for row in heads(records, known):
                scanned[folder] += 1
                record = records._envelope(row, verify_sources=False)
                if any(not records.memory.source_eligible(r['id'], request['scope']) for r in record['payload']['source_refs']):
                    outside += 1; continue
                p = record['payload']; detail = p.get('collective', {}).get('detail') if folder == 'collectives' else p.get('decision_case', {}).get('case')
                if not detail: continue
                if not (terms & words(_json(detail)) or matched_sources & {r['id'] for r in p['source_refs']}): continue
                if folder == 'collectives':
                    verified = collective_history(records, p['collective']['id'], known_at=known)[-1]
                    data = collective_public(records, verified, at)
                    units.append(dict(id='collective-'+digest(data['reference'])[:24], kind='collective', title=detail['title'], sourceRefs=verified['payload']['source_refs'],
                                      needs=['scope', 'condition', 'validity', 'antecedent'], requiresReview=True, blocked=False, data=data))
                else:
                    rows = records.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? AND record_id=? AND recorded_at<=? ORDER BY version LIMIT 101', (request['scope'], record['id'], sql_cut(known))).fetchall()
                    require(len(rows) <= 100, 'CONTEXT_DECISION_HISTORY_BUDGET')
                    verified = verify_chain(records, rows)[-1]; data = decision_public(verified)
                    refs = [verified['payload']['source_refs']]; evaluations = []; reviews = []; errors = []
                    with store(request, 'supports') as supports:
                        if supports is not None:
                            from .justifications import evaluate, history as support_history, digest as support_digest
                            for alternative in detail['alternatives']:
                                try:
                                    ev = evaluate(supports, dict(decision=data['reference'], alternativeId=alternative['id'], knownAt=known, validAt=at, mode=mode))
                                    evaluations.append(ev); refs.append(ev['sourceRefs'])
                                except RecordError as error:
                                    errors.append(dict(alternativeId=alternative['id'], reason=str(error)))
                            # Include exact review provenance, including reviews
                            # of underlying originals in collective requirements.
                            targets = {support_digest(dict(kind='source', **r)) for r in source_refs(refs)}
                            targets.update(support_digest(r['target']) for e in evaluations for i in e['items'] for r in i.get('requirements', []))
                            for impact in heads(supports, known):
                                raw = supports._envelope(impact, verify_sources=False); s = raw['payload'].get('support', {})
                                if s.get('kind') == 'impact' and s['id'] in targets:
                                    try:
                                        reviewed = support_history(supports, 'impact', s['id'], known)[-1]
                                        reviews.append(reviewed); refs.append(reviewed['payload']['source_refs'])
                                    except RecordError as error: errors.append(dict(reason=str(error)))
                        else:
                            evaluations = [dict(alternativeId=a['id'], state='pending', items=[], requiresReview=True, reason='no_admitted_justifications') for a in detail['alternatives']]
                    blocked = bool(errors)
                    unit = dict(id='decision-'+digest(data['reference'])[:24], kind='decision', title=detail['title'], sourceRefs=source_refs(refs),
                                needs=['decision_support', 'condition', 'revocation', 'contradiction', 'validity', 'scope'], requiresReview=True, blocked=blocked,
                                data=dict(case=data, alternatives=evaluations, evidenceReviews=reviews, errors=errors, executionAuthority=False, humanAcceptance=False))
                    units.append(unit)
                    if errors: blockers.append(dict(unitId=unit['id'], reason='decision_context_incomplete', errors=errors))
    with store(request, 'identities') as records:
        if records is not None:
            from .identities import resolve, context_unit
            board=resolve(records,dict(request,knownAt=known,validAt=at,mode=mode))
            scanned['identities']=len(board['entities'])+len(board['links']);outside+=board['outsideSelection']
            identity=context_unit(board,request['question'])
            if identity:
                units.append(identity)
                if identity['blocked']:blockers.append(dict(unitId=identity['id'],reason='identity_comparison_outside_selection'))
    with store(request, 'retrospectives') as records:
        if records is not None:
            from .retrospectives import context_units
            board, extra=context_units(records,dict(request,knownAt=known))
            if board['scanned']:scanned['retrospectives']=board['scanned']
            outside+=board['outsideSelection'];units.extend(extra)
            if board['outsideSelection']:blockers.append(dict(reason='retrospective_outside_selection'))
    with store(request, 'intelligence') as records:
        if records is not None:
            from .decision_intelligence import query as intelligence_query
            board=intelligence_query(records,dict(request,knownAt=known,view='all',question=''))
            if board['scanned']:scanned['intelligence']=board['scanned']
            outside+=board['outsideSelection']
            # Keep every related assessment/outcome of a matched decision, including adverse branches.
            def decisions_of(item):
                d=item['record']['payload']['intelligence']['detail']
                return {d[k]['caseId'] for k in ('decision','targetDecision') if k in d}
            hit={i['reference']['id'] for i in board['items'] if terms & words(_json(i['record']['payload']['intelligence']['detail']))}
            changed=True
            while changed:
                before=set(hit);cases=set().union(*(decisions_of(i) for i in board['items'] if i['reference']['id'] in hit)) if hit else set()
                for item in board['items']:
                    d=item['record']['payload']['intelligence']['detail'];links={d[k]['id'] for k in ('review','forecast') if k in d}
                    if item['reference']['id'] in hit or cases & decisions_of(item) or links & hit:hit.add(item['reference']['id']);hit.update(links)
                changed=hit!=before
            for item in board['items']:
                if item['reference']['id'] in hit:units.append(dict(id='intelligence-'+item['reference']['digest'][:24],kind='decision_intelligence',title=item['title'],sourceRefs=item['sourceRefs'],needs=['decision_support','scope','validity','contradiction','antecedent'],requiresReview=True,blocked=bool(board['outsideSelection']),data=item))
            if board['outsideSelection']:blockers.append(dict(reason='intelligence_outside_selection'))
    with store(request, 'causal') as records:
        if records is not None:
            from .causal import query as causal_query,terms_match
            board=causal_query(records,dict(request,knownAt=known,validAt=at,question=''))
            if board['scanned']:scanned['causal']=board['scanned']
            outside+=board['outsideSelection']
            cases={u['data']['case']['reference']['caseId'] for u in units if u['kind']=='decision'}
            for item in board['items']:
                d=item['record']['payload']['causal']['detail']
                if terms_match(request['question'],item) or d['decision'] and d['decision']['caseId'] in cases:
                    units.append(dict(id='causal-'+item['reference']['digest'][:24],kind='causal_explanation',title=item['title'],sourceRefs=item['sourceRefs'],needs=['source','antecedent','scope','validity','contradiction','decision_support'],requiresReview=True,blocked=bool(board['outsideSelection']),data=item))
            if board['outsideSelection']:blockers.append(dict(reason='causal_outside_selection'))
    require(len(units) <= 100, 'CONTEXT_UNIT_BUDGET')
    return dict(**{k: v for k, v in knowledge.items() if k not in ('contextUnits',)}, contextUnits=units,
                contextCut=dict(knownAt=known, validAt=at, mode=mode), contextScan=scanned, contextBlockers=blockers, outsideSelection=outside,
                contextCoverage='All bounded selected semantic heads inspected; unextracted text, implicit references and unknown validity prevent a global completeness claim.')
