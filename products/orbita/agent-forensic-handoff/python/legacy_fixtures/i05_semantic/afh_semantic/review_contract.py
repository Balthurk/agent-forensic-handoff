# Fixed-set partial correction guard adapted from Noetis.
def _clauses(old, new):
    if old is None and new is None:
        return
    if (not isinstance(old, dict) or not isinstance(new, dict)
            or old.get('act_id') != new.get('act_id')
            or old.get('target_ref') != new.get('target_ref')
            or old.get('local_act_key') != new.get('local_act_key')
            or set(old) - set(new)):
        raise ValueError('REVIEW_RECEIVER_ACT_LINEAGE')
    # This bounded receiver accepts explicit revisions of the existing clause set.
    # Adding/retiring or interpreting identity needs a later explicit mapping.
    a = {c['semantic_clause_id']: c for c in old['clauses']}
    b = {c['semantic_clause_id']: c for c in new['clauses']}
    if len(a) != len(old['clauses']) or len(b) != len(new['clauses']) or a.keys() != b.keys():
        raise ValueError('REVIEW_RECEIVER_CLAUSE_MAPPING_REQUIRED')
    for cid, prior in a.items():
        after = b[cid]
        if set(prior) - set(after):
            raise ValueError('REVIEW_RECEIVER_CLAUSE_FIELDS_REMOVED')
        x = {k:v for k,v in prior.items() if k != 'clause_version_id'}
        y = {k:v for k,v in after.items() if k != 'clause_version_id'}
        if (x == y) != (prior['clause_version_id'] == after['clause_version_id']):
            raise ValueError('REVIEW_RECEIVER_CLAUSE_VERSION_INVALID')
