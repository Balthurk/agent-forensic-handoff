"""Validated internal discovery hints; no support or relationship inference."""
import math
import re
from .knowledge_records import RecordError


def require(ok, suffix):
    if not ok:
        raise RecordError('CONTEXT_DISCOVERY_' + suffix)


def identifier(value):
    return isinstance(value, str) and 0 < len(value) <= 256


def sha(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None


def references_match(references, discovered):
    return any((ref['id'], ref['revision']) in discovered for ref in references)


def prepare_discovery(request):
    value = request.get('discovery')
    if value is None:
        return set(), [], None
    require(isinstance(value, dict) and set(value) == {'schema', 'channel', 'seedLimit', 'candidateCount', 'omittedSeeds', 'queryHints', 'seeds'}, 'FIELDS')
    require(value['schema'] == 'afh.context-discovery.v1' and value['channel'] == 'semantic_full_text' and type(value['seedLimit']) is int and value['seedLimit'] == 60, 'SCHEMA')
    seeds, count, omitted, hints = (value[k] for k in ('seeds', 'candidateCount', 'omittedSeeds', 'queryHints'))
    require(isinstance(seeds, list) and 0 < len(seeds) <= 60, 'SEED_BUDGET')
    require(type(count) is int and len(seeds) <= count <= 1200 and type(omitted) is int and omitted == count-len(seeds), 'COUNTS')
    require(isinstance(hints, list) and len(hints) <= 60 and all(isinstance(h, str) and h.strip() and len(h) <= 160 for h in hints), 'HINTS')
    require(len(set(hints)) == len(hints), 'HINTS_DUPLICATE')
    sources = {s['id']: s for s in request['sources']}
    refs = set()
    for seed in seeds:
        require(isinstance(seed, dict) and set(seed) == {'sourceId', 'revision', 'conversationId', 'caseHash', 'projectionId', 'similarity'}, 'SEED_FIELDS')
        require(all(identifier(seed[k]) for k in ('sourceId', 'conversationId', 'projectionId')) and seed['projectionId'].startswith('sem-'), 'IDENTITY')
        require(sha(seed['revision']) and sha(seed['caseHash']), 'REVISION')
        score = seed['similarity']
        require(type(score) in (int, float) and math.isfinite(score) and .35 <= score <= 1.000001, 'SIMILARITY')
        ref = (seed['sourceId'], seed['revision'])
        require(ref not in refs, 'DUPLICATE')
        source = sources.get(seed['sourceId'])
        require(source and not source.get('aliasOf') and source['revision'] == seed['revision'] and source.get('conversationId') == seed['conversationId'] and source.get('caseHash') == seed['caseHash'], 'SOURCE_BINDING')
        refs.add(ref)
    # Only fresh, exact alias proofs from verifiedSources may bridge a growing
    # capture to old record locators. Similar text alone is never an alias.
    seed_ids = {s['sourceId'] for s in seeds}
    aliases = []
    for alias in request['sources']:
        if alias.get('aliasOf') not in seed_ids:
            continue
        source = sources[alias['aliasOf']]
        fields = ('revision', 'payload_sha256', 'occurrence_id', 'text', 'text_sha256', 'role', 'record_sha256', 'source_conversation_id', 'conversationId', 'caseHash')
        require(all(k in alias and k in source and alias[k] == source[k] for k in fields), 'ALIAS_BINDING')
        witness = alias.get('aliasWitness')
        require(isinstance(witness, dict) and witness.get('representationId') == alias['id'] and identifier(witness.get('conversationId')) and sha(witness.get('caseHash')) and isinstance(witness.get('uri'), str) and bool(witness['uri']) and witness.get('recordSha256') == source['record_sha256'], 'ALIAS_WITNESS')
        require(alias.get('representation_id') == alias['id'] and bool(source['occurrence_id']) and alias['id'] != source['id'], 'ALIAS_IDENTITY')
        refs.add((alias['id'], alias['revision']))
        require(len(refs) <= 1000, 'ALIAS_BUDGET')
        aliases.append(dict(sourceId=alias['id'], revision=alias['revision'], aliasOf=source['id'], witness=witness))
    summary = dict(channel=value['channel'], seedLimit=60, candidateCount=count, acceptedSeeds=len(seeds), omittedSeeds=omitted, queryHints=hints, aliasReferences=len(aliases), referenceLimit=1000, meaning='candidate_discovery_only_no_relation_support_validity_or_authority')
    return refs, hints, dict(schema=value['schema'], summary=summary, seeds=seeds, aliases=aliases)
