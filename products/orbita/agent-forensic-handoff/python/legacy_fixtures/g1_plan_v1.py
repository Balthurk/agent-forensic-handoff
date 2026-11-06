"""Frozen I05 plan/receipt oracle. Test-only; no storage engine loaded.
Source SHA256: 160c8cf821a01bb96f327caae9f8561ab18f16d49939bb8918e1bda0669de34a
"""

import hashlib

from afh_semantic.knowledge_records import RecordError, _json

MAX_MEMBERS=1000

MAX_BYTES=16*1024*1024

POLICY={'backend':'sqlite-local-g1','remoteBackendQualified':False,'executionAuthority':False,
        'humanAcceptance':False,'truth':'not_established','validity':'not_established',
        'causality':'not_established','coverage':'Exact explicit semantic acts at one source cut; not all information'}

def require(ok,code):
    if not ok:raise RecordError(code)

def digest(value):return hashlib.sha256(_json(value).encode('utf8')).hexdigest()

def plan(records,oid):
    anchor=records.g1_outbox_entry(oid);members=records.g1_generation_members(oid,limit=MAX_MEMBERS)
    vertices=[];edges=[];missing=[];bindings=[];clauses=set()
    for m in members:
        r=records.get(m['record_id'],m['scope'],version=m['record_version']);p=r['payload'];u=p['semantic_unit']
        require(digest(p)==m['payload_sha256'] and digest(u['manifest'])==m['manifest_sha256'],'G1_N04_BINDING_MISMATCH')
        bindings.append({'outboxId':m['outbox_id'],'recordId':r['id'],'version':r['version'],'payloadHash':digest(p)})
        act='act:'+u['act_id']+':'+str(r['version']);vertices.append({'kind':'act','key':act,'value':r})
        for c in u['clauses']:
            key='clause:'+c['clause_version_id'];require(key not in clauses,'G1_DUPLICATE_CLAUSE');clauses.add(key)
            vertices.append({'kind':'clause','key':key,'value':{'recordId':r['id'],'version':r['version'],'clause':c}})
            edges.append({'kind':'contains','from':act,'to':key,'value':{'manifestHash':m['manifest_sha256']}})
    for v in vertices:
        if v['kind']!='clause':continue
        for rel in v['value']['clause'].get('relations',[]):
            target='clause:'+rel['target_clause_version_id'];edge={'kind':'relation','from':v['key'],'to':target,'value':rel}
            if target not in clauses:missing.append({'clauseVersionId':v['value']['clause']['clause_version_id'],'targetClauseVersionId':rel['target_clause_version_id'],'relation':rel,'reason':'exact_target_outside_generation'})
            else:edges.append(edge)
    for e in edges:e['key']='edge:'+digest(e)
    body={'schema':'orbita-g1-local-plan-1','anchor':oid,'scope':anchor['scope'],'sourceCut':anchor['source_cut'],
          'authorizationSnapshot':anchor['authorization_snapshot'],'members':bindings,
          'vertices':sorted(vertices,key=lambda x:x['key']),'edges':sorted(edges,key=lambda x:x['key']),
          'missingTargets':missing,'policy':POLICY}
    require(len(_json(body).encode('utf8'))<=MAX_BYTES,'G1_PLAN_BYTE_BUDGET')
    return {**body,'generation':'g1local-'+digest(body)}

def receipt(p,entry,readback):
    return {'schema':'orbita-g1-local-receipt-1','generation':p['generation'],'outboxId':p['anchor'],
            'scope':p['scope'],'sourceCut':p['sourceCut'],'fence':entry['fence_token'],
            'planHash':digest(p),'readbackHash':readback,'members':len(p['members']),
            'vertices':len(p['vertices']),'edges':len(p['edges']),'policy':POLICY}
