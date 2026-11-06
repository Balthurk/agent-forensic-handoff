"""Read a bounded history pinned to a version already present in a query snapshot."""
from .context_retrieval import store
from .host import require, digest
from .collectives import history as collective_history, sql_cut, reference as collective_ref
from .decisions import verify_chain, reference as decision_ref
from .justifications import history as support_history, reference as support_ref
from .relational_memory import instant
from . import retrospectives, decision_intelligence, causal

DERIVED={'retrospective':('retrospectives',retrospectives), 'decision_intelligence':('intelligence',decision_intelligence), 'causal_explanation':('causal',causal)}

def dispatch_history(request):
    t=request['target'];kind=t.get('kind');known=request['knownAt'];instant(known)
    require(kind in ('semantic','collective','decision','justification','identity_entity','identity_link') or kind in DERIVED,'EXPLORER_HISTORY_KIND')
    require(type(t.get('version')) is int and 1<=t['version']<=100,'EXPLORER_HISTORY_VERSION')
    folder=DERIVED[kind][0] if kind in DERIVED else {'semantic':'','collective':'collectives','decision':'decisions','justification':'supports','identity_entity':'identities','identity_link':'identities'}[kind]
    with store(request,folder) as records:
        require(records is not None,'EXPLORER_HISTORY_UNAVAILABLE')
        if kind in DERIVED:
            rid_value=DERIVED[kind][1].rid(request['scope'],t['id'])
        elif kind=='collective':
            # Exact version's timestamp prevents later/backdated versions from
            # changing the historical chain that this endpoint verifies.
            from .collectives import rid
            rid_value=rid(request['scope'],t['id'])
        elif kind=='justification':
            from .justifications import record_id
            rid_value=record_id(request['scope'],'justification',t['id'])
        elif kind=='decision':
            from .decisions import rid
            rid_value=rid(request['scope'],t['caseId'])
        elif kind.startswith('identity_'):
            from .identities import rid
            rid_value=rid(request['scope'],kind.removeprefix('identity_'),t['id'])
        else: rid_value=t['id']
        rows=records.db.execute('SELECT rowid AS _rowid,* FROM record_versions WHERE scope=? AND record_id=? AND version<=? AND recorded_at<=? ORDER BY version LIMIT 101',(request['scope'],rid_value,t['version'],sql_cut(known))).fetchall()
        require(bool(rows) and len(rows)<=100 and rows[-1]['version']==t['version'],'EXPLORER_HISTORY_CUT')
        pinned=rows[-1]['recorded_at']
        if kind in DERIVED:
            module=DERIVED[kind][1]
            # Both bounds matter: a later version may share or backdate a timestamp.
            chain=module.history(records,t['id'],known=pinned,version=t['version']);ref=module.reference
        elif kind=='collective': chain=collective_history(records,t['id'],known_at=pinned); ref=collective_ref
        elif kind=='justification': chain=support_history(records,'justification',t['id'],pinned);ref=support_ref
        elif kind=='decision': chain=verify_chain(records,rows);ref=decision_ref
        elif kind.startswith('identity_'):
            from .identities import history,reference
            chain=history(records,kind.removeprefix('identity_'),t['id'],pinned);ref=reference
        else:
            chain=[records._envelope(row) for row in rows]
            require(all(r['version']==i+1 for i,r in enumerate(chain)),'EXPLORER_HISTORY_CHAIN')
            require(any(c['clause_version_id']==t['clauseVersionId'] for c in chain[-1]['payload']['semantic_unit']['clauses']),'EXPLORER_CLAUSE_BINDING')
            ref=lambda r:dict(id=r['id'],version=r['version'],digest=digest(r))
        require(chain[-1]['version']==t['version'],'EXPLORER_HISTORY_PIN')
        if kind!='semantic':require(ref(chain[-1])['digest']==t['digest'],'EXPLORER_HISTORY_DIGEST')
        return dict(kind=kind,knownAt=known,items=[dict(reference=ref(r),record=r) for r in chain],meaning='System recording history, not event dates, truth or human knowledge.')
