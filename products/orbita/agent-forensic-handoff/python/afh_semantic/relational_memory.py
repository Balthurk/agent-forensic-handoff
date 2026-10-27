"""Bounded relations on the existing N04 ledger, with N01 as evidence authority.

Selection order follows the behavior reviewed in own AFH temporal.js SHA
cc7a1b9ad2333d8db4181bfa8a401ce5b512d390cf9d450e78522cfb77802074
(Apache-2.0); independent Python implementation, no donor code imported/copied.
System history only. Paths explain connections, never transitivity or causality.
"""
from collections import deque
from datetime import datetime, timezone, timedelta
import re
import sqlite3

from .knowledge_records import RecordError, _identifier, _json, _text

DEFAULT_BUDGET = {"max_rows": 2000, "max_input_bytes": 4000000,
                  "max_sql_steps": 300000, "max_work": 20000,
                  "max_edges": 1000, "max_nodes": 200,
                  "max_sources": 100, "max_source_bytes": 4000000,
                  "max_context_bytes": 64000}
_TIMESTAMP = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$")

def instant(value):
    """RFC3339 to integer nanoseconds; reject unknown zone and lossy precision."""
    match = _TIMESTAMP.fullmatch(value) if isinstance(value,str) else None
    if not match or match[8] == "-00:00":
        raise RecordError("INVALID_TIME")
    year,month,day,hour,minute,second = map(int,match.groups()[:6])
    fraction,zone = match[7] or "",match[8]
    try:
        base=datetime(year,month,day,hour,minute,second,tzinfo=timezone.utc)
        offset=0
        if zone != "Z":
            hours,minutes=int(zone[1:3]),int(zone[4:6])
            if hours>23 or minutes>59: raise ValueError("offset")
            offset=(1 if zone[0]=="+" else -1)*(hours*3600+minutes*60)
        delta=base-datetime(1970,1,1,tzinfo=timezone.utc)
        return (delta.days*86400+delta.seconds-offset)*1000000000+int(fraction.ljust(9,"0"))
    except ValueError as error:
        raise RecordError("INVALID_TIME") from error

def _bound(value,position):
    if not isinstance(value,dict): raise RecordError("INVALID_BOUND")
    kind=value.get("kind")
    if kind=="known":
        point=instant(value.get("value"))
        match=_TIMESTAMP.fullmatch(value["value"])
        digits=len(match[7] or "")
        if value.get("precision") != {0:"s",3:"ms",6:"us",9:"ns"}.get(digits) or value.get("timezone") != match[8]:
            raise RecordError("INVALID_PRECISION")
        return point
    allowed={"unknown","unbounded"} if position!="event_at" else {"unknown"}
    if position=="valid_to": allowed.add("open")
    if kind not in allowed or value.get("value") is not None or value.get("precision")!="unknown" or value.get("timezone") is not None:
        raise RecordError("INVALID_BOUND")
    return None

def validate_graph(payload):
    graph=payload.get("graph")
    if not isinstance(graph,dict) or graph.get("kind") not in ("entity","relation"):
        raise RecordError("INVALID_GRAPH")
    if not isinstance(payload.get("negated"),bool): raise RecordError("NEGATION_REQUIRED")
    conditions=payload.get("conditions")
    if not isinstance(conditions,list) or len(conditions)>50 or any(not isinstance(v,str) or not v.strip() or len(v)>2000 for v in conditions):
        raise RecordError("INVALID_CONDITIONS")
    if graph.get("classification") not in ("explicit","inferred"):
        raise RecordError("INVALID_CLASSIFICATION")
    if graph["classification"]=="inferred" and payload.get("status")!="proposed":
        raise RecordError("APPROVAL_REQUIRED")
    if graph["kind"]=="entity":
        _text(graph.get("entity_type"),"entity_type",128)
    else:
        _identifier(graph.get("subject")); _identifier(graph.get("object"))
        _text(graph.get("predicate"),"predicate",128)
    temporal=payload.get("temporal")
    if not isinstance(temporal,dict): raise RecordError("TEMPORAL_REQUIRED")
    start=_bound(temporal.get("valid_from"),"valid_from")
    end=_bound(temporal.get("valid_to"),"valid_to")
    _bound(temporal.get("event_at"),"event_at")
    if start is not None and end is not None and start>=end:
        raise RecordError("INVALID_TEMPORAL_RANGE")

class _Limit(Exception):
    pass

class _Budget:
    def __init__(self,limits):
        if limits is not None and (not isinstance(limits,dict) or set(limits)-set(DEFAULT_BUDGET)):
            raise RecordError("INVALID_BUDGET")
        self.limits={**DEFAULT_BUDGET,**(limits or {})}
        for name,value in self.limits.items():
            if isinstance(value,bool) or not isinstance(value,int) or value<1 or value>DEFAULT_BUDGET[name]*10:
                raise RecordError("INVALID_BUDGET",name)
        if self.limits["max_context_bytes"]<2048: raise RecordError("INVALID_BUDGET","context minimum 2048 bytes")
        self.used={name[4:]:0 for name in self.limits}
    def take(self,name,count=1):
        self.used[name]+=count
        if self.used[name]>self.limits["max_"+name]: raise _Limit(name)
    def progress(self):
        try: self.take("sql_steps",100); return 0
        except _Limit: return 1


def _project(record, contradicts=()):
    """Allowlist the context; arbitrary preserved metadata is not historical output."""
    p=record["payload"]
    fields=("id","scope","type","text","modality","status","negated","conditions")
    payload={key:p[key] for key in fields}
    payload["actor"]={key:p["actor"][key] for key in ("id","role")}
    graph=p["graph"]
    keys=("kind","entity_type","classification") if graph["kind"]=="entity" else ("kind","subject","predicate","object","classification")
    payload["graph"]={key:graph[key] for key in keys}
    payload["temporal"]={key:{field:p["temporal"][key][field] for field in ("kind","value","precision","timezone")} for key in ("valid_from","valid_to","event_at")}
    payload["source_refs"]=[{key:ref[key] for key in ("id","revision")} for ref in p["source_refs"]]
    payload["contradicts"]=list(contradicts)
    if p["status"]=="approved":
        approval=p["approval"]
        payload["approval"]={"source_ref":{key:approval["source_ref"][key] for key in ("id","revision")},"quote":approval["quote"]}
    return {"id":record["id"],"version":record["version"],"recorded_at":record["recorded_at"],"integrity":record["integrity"],"payload":payload,
            "contradictions_omitted":len(p.get("contradicts",[]))-len(contradicts)}

class RelationalMemory:
    def __init__(self,records):
        self.records=records
    def put(self,payload,*,expected_version,request_id):
        validate_graph(payload)
        return self.records.put(payload,expected_version=expected_version,request_id=request_id)

    def _acquire(self,scope,known_at,budget,record_id=None):
        _text(scope,"scope",128)
        cutoff=instant(known_at) if known_at is not None else None
        records=self.records
        selected=[]
        records.db.set_progress_handler(budget.progress,100)
        try:
            clauses=["scope=?"]; params=[scope]
            if record_id is not None: clauses.append("record_id=?"); params.append(record_id)
            if cutoff is not None:
                # New N04 timestamps are canonical UTC microseconds. Floor the query's
                # nanoseconds only for this indexed prefilter; verify exact values below.
                try:
                    sql_cut=(datetime(1970,1,1,tzinfo=timezone.utc)+timedelta(microseconds=cutoff//1000)).isoformat(timespec="microseconds")
                except (OverflowError,ValueError) as error:
                    raise RecordError("INVALID_TIME", "UTC outside supported calendar") from error
                clauses.append("recorded_at<=?"); params.append(sql_cut)
            params.append(budget.limits["max_rows"]+1)
            sizes="+".join("length(CAST("+key+" AS BLOB))" for key in ("record_id","scope","recorded_at","payload","payload_sha256","request_id","request_sha256"))
            rows=records.db.execute("SELECT rowid AS _rowid,"+sizes+"+128 AS bytes FROM record_versions WHERE "+" AND ".join(clauses)+" ORDER BY rowid LIMIT ?",params)
            for header in rows:
                budget.take("rows"); budget.take("work"); budget.take("input_bytes",header["bytes"])
                row=records.db.execute("SELECT rowid AS _rowid,* FROM record_versions WHERE rowid=?",(header["_rowid"],)).fetchone()
                # Every revision USED must have its entire envelope verified. The
                # future is not loaded or reported by this historical query.
                record=records._envelope(row,verify_sources=False)
                if cutoff is not None and instant(record["recorded_at"])>cutoff: continue
                if "graph" not in record["payload"]: continue
                if record["integrity"]!="envelope_v1": raise RecordError("HISTORICAL_INTEGRITY_UNAVAILABLE")
                selected.append(record)
            return selected
        except sqlite3.OperationalError as error:
            if "interrupt" in str(error).lower(): raise _Limit("sql_steps") from error
            raise
        finally:
            records.db.set_progress_handler(None,0)

    def _sources(self,record,budget,verified):
        for ref in record["payload"]["source_refs"]:
            key=(ref["id"],ref["revision"],record["payload"]["scope"])
            if key in verified: continue
            budget.take("sources"); budget.take("work")
            memory = self.records.memory
            if callable(getattr(memory, "source_size", None)):
                size = memory.source_size(*key)
            else:
                row=memory.db.execute("SELECT r.byte_length FROM records r WHERE r.id=? AND r.revision=? AND EXISTS(SELECT 1 FROM occurrences o WHERE o.revision=r.revision AND o.project=?)",key).fetchone()
                size = None if row is None else row[0]
            if size is None: raise RecordError("SOURCE_SCOPE_MISMATCH")
            budget.take("source_bytes",size)
            verified[key]=self.records._source(ref,key[2])
        approval=record["payload"].get("approval")
        if record["payload"]["status"]=="approved":
            ref=approval["source_ref"]
            # Reuse the same source budget for the separate human approval evidence.
            shadow={"payload":{"scope":record["payload"]["scope"],"source_refs":[ref],"status":"proposed"}}
            self._sources(shadow,budget,verified)
            source=verified[(ref["id"],ref["revision"],record["payload"]["scope"])]
            quote=approval["quote"]
            if source.get("role")!="user" or source["text"].strip() not in (quote,"user\n"+quote):
                raise RecordError("APPROVAL_REQUIRED")

    @staticmethod
    def _valid(record,at,include_uncertain):
        if at is None: return True
        t=record["payload"]["temporal"]
        start,end=_bound(t["valid_from"],"valid_from"),_bound(t["valid_to"],"valid_to")
        if start is not None and at<start or end is not None and at>=end: return False
        return include_uncertain or all(t[key]["kind"]!="unknown" for key in ("valid_from","valid_to"))

    def _projection(self,record,meter,verified,*,known_at,valid,include_uncertain,
                    candidates=None,cache=None):
        """Resolve contradiction IDs without exposing ineligible or future targets.

        Context reuses already filtered rows. Point/history reads acquire only
        referenced IDs under the SAME budget and cut. This is not recursive
        contradiction expansion and never promotes a winner.
        """
        self._sources(record,meter,verified)
        if cache is None: cache={}
        links=[]
        for target_id in record["payload"].get("contradicts",[]):
            meter.take("work")
            if candidates is not None:
                target=candidates.get(target_id)
            else:
                if target_id not in cache:
                    rows=self._acquire(record["payload"]["scope"],known_at,meter,target_id)
                    target=max(rows,key=lambda r:r["version"]) if rows else None
                    cache[target_id]=target if target is not None and self._valid(target,valid,include_uncertain) else None
                target=cache[target_id]
            if target is not None:
                self._sources(target,meter,verified)
                links.append(target_id)
        return _project(record,links)

    def history(self,record_id,scope,*,known_at=None,budget=None):
        _identifier(record_id); meter=_Budget(budget)
        try:
            rows=self._acquire(scope,known_at,meter,record_id)
            verified={}; cache={}
            output=[self._projection(row,meter,verified,known_at=known_at,valid=None,
                                     include_uncertain=False,cache=cache) for row in rows]
            if len(_json(output).encode("utf-8"))>meter.limits["max_context_bytes"]: raise _Limit("context_bytes")
            return output
        except _Limit as error: raise RecordError("QUERY_BUDGET_EXCEEDED",str(error)) from error

    def get(self,record_id,scope,*,known_at=None,valid_at=None,include_uncertain=False,budget=None):
        _identifier(record_id)
        if not isinstance(include_uncertain,bool): raise RecordError("INVALID_QUERY")
        meter=_Budget(budget); valid=instant(valid_at) if valid_at is not None else None
        try:
            rows=self._acquire(scope,known_at,meter,record_id)
            if not rows: raise RecordError("NOT_FOUND")
            row=max(rows,key=lambda r:r["version"])
            if not self._valid(row,valid,include_uncertain): raise RecordError("NOT_FOUND")
            output=self._projection(row,meter,{},known_at=known_at,valid=valid,
                                    include_uncertain=include_uncertain)
            if len(_json(output).encode("utf-8"))>meter.limits["max_context_bytes"]: raise _Limit("context_bytes")
            return output
        except _Limit as error: raise RecordError("QUERY_BUDGET_EXCEEDED",str(error)) from error

    def context(self,scope,*,roots=None,known_at=None,valid_at=None,include_uncertain=False,
                direction="out",predicates=None,max_hops=2,budget=None,
                query=None,query_match="all",root_limit=8):
        if direction not in ("out","in","both") or isinstance(max_hops,bool) or not isinstance(max_hops,int) or not 0<=max_hops<=3 or not isinstance(include_uncertain,bool):
            raise RecordError("INVALID_QUERY")
        if query_match not in ("all","any") or type(root_limit) is not int or not 1<=root_limit<=20:
            raise RecordError("INVALID_QUERY")
        if query is not None and (not isinstance(query,str) or not query.strip() or len(query)>512 or roots is not None):
            raise RecordError("INVALID_QUERY")
        if roots is not None:
            if not isinstance(roots,list) or len(roots)>100: raise RecordError("INVALID_ROOTS")
            for root in roots: _identifier(root)
        if predicates is not None:
            if not isinstance(predicates,list) or len(predicates)>100: raise RecordError("INVALID_PREDICATES")
            for predicate in predicates: _text(predicate,"predicate",128)
        valid=instant(valid_at) if valid_at is not None else None
        meter=_Budget(budget)
        packet={"schema_version":"noetis.relational-context.v1","mode":"system_history","scope":scope,
                "known_at":known_at,"valid_at":valid_at,"include_uncertain":include_uncertain,
                "records":[],"paths":[],"omissions":[],"status":"no_precedent_found",
                "authority":"source-backed proposals; paths are not transitive or causal claims",
                "temporal_scope":"real system history; corpus reconstruction pending",
                "path_policy":"one representative traversal per reached edge; node expansion once; cycles flagged; not all path combinations"}
        if query is not None:
            packet["selection"]={"method":"unicode_casefold_terms", "match":query_match,
                "root_limit":root_limit, "eligible":0, "examined":0, "matching":0, "omitted":0,
                "roots":[], "scanned_bytes":0,
                "cost_scope":"logical UTF-8 scanned; work charges characters, tokens, comparisons and sort; acquisition unchanged"}
        try:
            rows=self._acquire(scope,known_at,meter)
            latest={}
            for row in rows:
                meter.take("work")
                if row["id"] not in latest or row["version"]>latest[row["id"]]["version"]: latest[row["id"]]=row
            eligible={key:row for key,row in latest.items() if self._valid(row,valid,include_uncertain)}
            if len(eligible)<len(latest):
                packet["omissions"].append({"reason":"validity_not_matching_or_unknown","count":len(latest)-len(eligible)})
            nodes={key:row for key,row in eligible.items() if row["payload"]["graph"]["kind"]=="entity"}
            if query is not None:
                selection=packet["selection"]; selection["eligible"]=len(nodes)
                # Charge scans before casefold/tokenization, including long nonmatching text.
                # N04 row bytes already count in input_bytes; query bytes are additional input.
                meter.take("input_bytes",len(query.encode("utf-8")))
                def terms(value):
                    meter.take("work",len(value))
                    selection["scanned_bytes"]+=len(value.encode("utf-8"))
                    found=set()
                    for match in re.finditer(r"\w+",value.casefold()):
                        meter.take("work"); found.add(match.group())
                    return found
                wanted=terms(query); matches=[]
                for key,row in nodes.items():
                    meter.take("work"); selection["examined"]+=1
                    payload=row["payload"]
                    searchable=terms(payload["text"]) | terms(payload["graph"]["entity_type"])
                    meter.take("work",len(wanted))
                    score=sum(term in searchable for term in wanted)
                    if score and (query_match=="any" or score==len(wanted)):
                        matches.append((-score,key))
                selection["matching"]=len(matches)
                meter.take("work",len(matches)*max(1,len(matches).bit_length()))
                matches.sort()
                roots=[key for _,key in matches[:root_limit]]
                selection["roots"]=roots
                selection["omitted"]=max(0,len(matches)-root_limit)
            edges={}; missing_endpoints=0
            for key,row in eligible.items():
                meter.take("work")
                g=row["payload"]["graph"]
                if g["kind"]!="relation": continue
                if g["subject"] not in nodes or g["object"] not in nodes:
                    missing_endpoints+=1; continue
                if predicates is not None and g["predicate"] not in predicates: continue
                meter.take("edges"); edges[key]=row
            if missing_endpoints:
                packet["omissions"].append({"reason":"endpoint_not_eligible","count":missing_endpoints})
            if roots is None:
                chosen=set(nodes)|set(edges); paths=[]
                meter.take("nodes",len(nodes))
            else:
                adjacency={key:[] for key in nodes}
                for key,row in edges.items():
                    meter.take("work"); g=row["payload"]["graph"]
                    if direction in ("out","both"): adjacency[g["subject"]].append((key,g["object"]))
                    if direction in ("in","both"): adjacency[g["object"]].append((key,g["subject"]))
                for neighbors in adjacency.values(): neighbors.sort()
                chosen=set(); visited=set(); queue=deque(); paths=[]
                for root in roots:
                    if root in nodes and root not in visited:
                        meter.take("nodes"); visited.add(root); chosen.add(root); queue.append(([root],[]))
                while queue:
                    path,links=queue.popleft()
                    if len(links)>=max_hops: continue
                    for edge,target in adjacency[path[-1]]:
                        meter.take("work")
                        # Deduplicate expansion, never the assertions themselves:
                        # parallel, negative and cycle-closing edges remain evidence.
                        if edge in chosen: continue
                        expand=target not in visited
                        if expand:
                            meter.take("nodes"); visited.add(target)
                        chosen.update((edge,target))
                        next_path,next_links=path+[target],links+[edge]
                        refs=[]
                        for link in next_links:
                            refs.extend({k:ref[k] for k in ("id","revision")} for ref in edges[link]["payload"]["source_refs"])
                        claims=[]
                        for link in next_links:
                            claim=edges[link]["payload"]
                            claims.append({"id":link,"classification":claim["graph"]["classification"],
                                           **{field:claim[field] for field in ("modality","negated","conditions","status")}})
                        paths.append({"nodes":next_path,"edges":next_links,"source_refs":refs,
                                      "claims":claims,"conditions_evaluated":False,
                                      "interpretation":"connections_between_recorded_claims",
                                      "cycle_closure":target in path})
                        if expand: queue.append((next_path,next_links))
            verified={}; visible={**nodes,**edges}; projected={}
            for key in sorted(chosen):
                projected[key]=self._projection(eligible[key],meter,verified,known_at=known_at,
                                                valid=valid,include_uncertain=include_uncertain,
                                                candidates=visible)
                packet["records"].append(projected[key])
            omitted=sum(row["contradictions_omitted"] for row in packet["records"])
            if omitted:
                packet["omissions"].append({"reason":"contradiction_target_not_eligible","count":omitted})
            for path in paths:
                for claim in path["claims"]:
                    meter.take("work")
                    claim["contradicts"]=projected[claim["id"]]["payload"]["contradicts"]
                    claim["contradictions_omitted"]=projected[claim["id"]]["contradictions_omitted"]
            packet["paths"]=paths
            packet["status"]="records_found" if packet["records"] else "no_precedent_found"
        except _Limit as error:
            # A partial input could select a superseded revision: discard it completely.
            packet["records"]=[]; packet["paths"]=[]
            if "selection" in packet: packet["selection"]["roots"]=[]
            packet["status"]="budget_exceeded"; packet["omissions"]=[{"reason":"budget_"+str(error),"coverage":"incomplete; no partial selection returned"}]
        packet["budget"]={"limits":meter.limits,"used":meter.used}
        # Size includes metadata, evidence refs, paths, omissions and this receipt.
        for _ in range(4):
            meter.used["context_bytes"]=len(_json(packet).encode("utf-8"))
        if meter.used["context_bytes"]>meter.limits["max_context_bytes"]:
            packet["records"]=[]; packet["paths"]=[]; packet["status"]="budget_exceeded"
            if "selection" in packet: packet["selection"]["roots"]=[]
            packet["omissions"]=[{"reason":"budget_context_bytes","coverage":"incomplete; no partial selection returned"}]
            for _ in range(4): meter.used["context_bytes"]=len(_json(packet).encode("utf-8"))
        if meter.used["context_bytes"]>meter.limits["max_context_bytes"]:
            raise RecordError("QUERY_BUDGET_EXCEEDED","diagnostic envelope exceeds context budget")
        return packet
