"""Mechanical reception for N04 semantic acts.

This validates syntax, source-bound locators and internal hashes. It does not
judge whether a quote supports an interpretation or publish a graph generation.
"""
import hashlib


def validate_new_temporal_bounds(payload):
    """Existing optional bound field type, only for a new N04 commit.

    Sealed legacy proposals/replays retain their original representation. Unknown
    fields remain private; this does not parse dates or judge temporal meaning.
    The caller has already performed the ordinary semantic-unit validation.
    """
    from afh_semantic.knowledge_records import RecordError
    unit = payload.get("semantic_unit")
    if not isinstance(unit, dict) or unit.get("schema_version") != "noetis.semantic-act.v1":
        return
    for clause in unit["clauses"]:
        for temporal in clause.get("temporal", []):
            for endpoint in ("lower", "upper"):
                bound = temporal.get("bounds", {}).get(endpoint)
                if isinstance(bound, dict) and "source_expression" in bound and not isinstance(bound["source_expression"], str):
                    raise RecordError("SEMANTIC_TEMPORAL_BOUNDS")


def _typed_shapes(clause, evidence):
    """Bounded mechanical check for optional v1 projections; no semantic judgment."""
    from afh_semantic.knowledge_records import RecordError, _identifier

    def fail(code):
        raise RecordError(code)

    def nonempty(value):
        return isinstance(value, str) and bool(value.strip())

    def keys(value, required):
        return isinstance(value, list) and bool(value) and all(nonempty(v) and v.startswith("/") for v in value)

    def ast(node, depth=0):
        if depth > 12 or not isinstance(node, dict) or not nonempty(node.get("scope")) or not keys(node.get("evidence_keys"), True):
            fail("SEMANTIC_CONDITION_AST")
        if "operator" in node:
            op, operands = node.get("operator"), node.get("operands")
            if op not in ("all", "any", "not") or not isinstance(operands, list) or len(operands) != (1 if op == "not" else max(2, len(operands))):
                fail("SEMANTIC_CONDITION_AST")
            for child in operands:
                ast(child, depth + 1)
            return
        kind = node.get("kind")
        if kind not in ("literal_condition", "antecedent_ref", "clause_ref", "comparison", "unresolved") or not nonempty(node.get("literal")):
            fail("SEMANTIC_CONDITION_AST")
        if node.get("quantifier", "unknown") not in ("specific", "all", "any", "unknown"):
            fail("SEMANTIC_CONDITION_AST")
        if kind == "clause_ref":
            _identifier(node.get("target_clause_version_id"))
        if kind == "antecedent_ref" and not isinstance(node.get("source_ref"), dict):
            fail("SEMANTIC_CONDITION_AST")
        if kind == "comparison":
            comp = node.get("comparison")
            if not isinstance(comp, dict) or comp.get("relation") not in ("eq", "neq", "lt", "lte", "gt", "gte", "contains", "before", "after") or any(not nonempty(comp.get(k)) for k in ("left", "right")):
                fail("SEMANTIC_CONDITION_AST")

    def zone(value):
        if not isinstance(value, dict) or value.get("kind") not in ("iana", "utc_offset", "floating", "unknown"):
            fail("SEMANTIC_TEMPORAL_ZONE")
        kind = value["kind"]
        if kind == "iana" and not nonempty(value.get("id")):
            fail("SEMANTIC_TEMPORAL_ZONE")
        if kind == "utc_offset" and (type(value.get("offset_minutes")) is not int or not -840 <= value["offset_minutes"] <= 840):
            fail("SEMANTIC_TEMPORAL_ZONE")
        if kind in ("floating", "unknown") and ("id" in value or "offset_minutes" in value):
            fail("SEMANTIC_TEMPORAL_ZONE")

    precisions = {"instant", "second", "minute", "hour", "day", "month", "year", "range", "unknown"}
    def bound(value):
        if not isinstance(value, dict) or not nonempty(value.get("value")) or type(value.get("inclusive")) is not bool or not isinstance(value.get("precision"), str) or value["precision"] not in precisions:
            fail("SEMANTIC_TEMPORAL_BOUNDS")
        zone(value.get("zone"))

    for field in ("alternatives", "relations"):
        if not isinstance(clause.get(field, []), list):
            fail("SEMANTIC_FIELD_SHAPE")
    for item in clause.get("conditions", []):
        if "ast" in item:
            ast(item["ast"])
    for item in clause.get("temporal", []):
        status = item["status"]
        has_value, has_bounds = "value" in item, "bounds" in item
        if "precision" in item and (not isinstance(item["precision"], str) or item["precision"] not in precisions):
            fail("SEMANTIC_TEMPORAL")
        if "zone" in item:
            zone(item["zone"])
        if status in ("unknown", "not_stated", "not_applicable", "ambiguous") and has_value:
            fail("SEMANTIC_TEMPORAL")
        if status in ("unknown", "not_stated", "not_applicable") and has_bounds:
            fail("SEMANTIC_TEMPORAL")
        if status in ("exact", "approximate", "open_bound"):
            if has_value == has_bounds:
                fail("SEMANTIC_TEMPORAL")
            if has_value and (not nonempty(item["value"]) or item.get("precision") not in precisions or "zone" not in item or status == "open_bound"):
                fail("SEMANTIC_TEMPORAL")
        if has_bounds:
            bounds = item["bounds"]
            if not isinstance(bounds, dict) or bounds.get("relation") not in ("closed_interval", "lower_open", "upper_open", "unbounded", "approximate_range"):
                fail("SEMANTIC_TEMPORAL_BOUNDS")
            rel = bounds["relation"]
            required = {"closed_interval": {"lower", "upper"}, "lower_open": {"upper"}, "upper_open": {"lower"}, "unbounded": set(), "approximate_range": {"lower", "upper", "uncertainty"}}[rel]
            allowed_endpoints = {"closed_interval": {"lower", "upper"}, "approximate_range": {"lower", "upper"},
                                 "lower_open": {"upper"}, "upper_open": {"lower"}, "unbounded": set()}[rel]
            actual_endpoints = {key for key in ("lower", "upper") if key in bounds}
            if (not required <= bounds.keys() or actual_endpoints != allowed_endpoints or
                (status == "exact" and rel != "closed_interval") or
                (status == "approximate" and rel not in ("closed_interval", "approximate_range")) or
                (status == "open_bound" and rel not in ("lower_open", "upper_open", "unbounded"))):
                fail("SEMANTIC_TEMPORAL_BOUNDS")
            for endpoint in ("lower", "upper"):
                if endpoint in bounds:
                    bound(bounds[endpoint])
            if rel == "approximate_range" and not nonempty(bounds.get("uncertainty")):
                fail("SEMANTIC_TEMPORAL_BOUNDS")
    for alt in clause.get("alternatives", []):
        if not isinstance(alt, dict) or not nonempty(alt.get("slot")) or not alt["slot"].startswith("/") or alt.get("state") not in ("unresolved", "selected", "rejected", "conflicting") or not isinstance(alt.get("evidence_keys"), list) or not isinstance(alt.get("candidates"), list) or not alt["candidates"]:
            fail("SEMANTIC_ALTERNATIVE")
        if alt["state"] == "selected" and (type(alt.get("selected_index")) is not int or not 0 <= alt["selected_index"] < len(alt["candidates"])):
            fail("SEMANTIC_ALTERNATIVE")
        if alt["state"] != "selected" and "selected_index" in alt:
            fail("SEMANTIC_ALTERNATIVE")
        for candidate in alt["candidates"]:
            if not isinstance(candidate, dict) or not nonempty(candidate.get("literal")) or candidate.get("resolution") not in ("supported", "near_match", "contradicted", "insufficient", "unopened") or not isinstance(candidate.get("evidence_keys"), list):
                fail("SEMANTIC_ALTERNATIVE")
            if "target_clause_version_id" in candidate:
                _identifier(candidate["target_clause_version_id"])
    for rel in clause.get("relations", []):
        if not isinstance(rel, dict) or rel.get("kind") not in ("revises", "split_from", "merged_from", "equivalent", "compatible", "exception", "partial_modification", "substitution", "contradiction", "retracts", "confirms", "amplifies", "depends_on", "equivalence_candidate") or rel.get("direction") != "outgoing" or rel.get("status") not in ("supported", "candidate", "insufficient", "contradicted") or not keys(rel.get("evidence_keys"), True):
            fail("SEMANTIC_RELATION")
        _identifier(rel.get("target_clause_version_id"))
    def check_evidence_keys(node):
        if isinstance(node, dict):
            if "evidence_keys" in node:
                values = node["evidence_keys"]
                if not isinstance(values, list) or any(not nonempty(v) or not v.startswith("/") or v not in evidence for v in values):
                    fail("SEMANTIC_TYPED_EVIDENCE")
            for value in node.values():
                check_evidence_keys(value)
        elif isinstance(node, list):
            for value in node:
                check_evidence_keys(value)
    for field in ("conditions", "temporal", "alternatives", "relations"):
        check_evidence_keys(clause.get(field, []))


def validate_semantic_unit(payload, source_lookup, *, support_lookup=None):
    from afh_semantic.knowledge_records import RecordError, _identifier, _json

    unit = payload.get("semantic_unit")
    if not isinstance(unit, dict) or unit.get("schema_version") != "noetis.semantic-act.v1":
        raise RecordError("SEMANTIC_SCHEMA_UNSUPPORTED")
    _identifier(unit.get("act_id"))
    if unit.get("scope") != payload["scope"]:
        raise RecordError("SEMANTIC_SCOPE_MISMATCH")
    if not isinstance(unit.get("content_kind"), str) or not unit["content_kind"].strip():
        raise RecordError("SEMANTIC_CONTENT_KIND")
    if not isinstance(unit.get("interpretation_version"), str) or not unit["interpretation_version"].strip():
        raise RecordError("SEMANTIC_INTERPRETATION_VERSION")
    cut = unit.get("context_cut")
    if not isinstance(cut, dict) or cut.get("scope") != payload["scope"] or any(
        not isinstance(cut.get(key), str) or not cut[key].strip()
        for key in ("source_cut", "authorization_snapshot")
    ):
        raise RecordError("SEMANTIC_CONTEXT_CUT")
    refs = {(r["id"], r["revision"]) for r in payload["source_refs"]}
    source_cache = {}

    def source(source_id, revision):
        key = (source_id, revision)
        if key not in refs:
            raise RecordError("SEMANTIC_SOURCE_NOT_LISTED")
        if key not in source_cache:
            source_cache[key] = source_lookup({"id": source_id, "revision": revision}, payload["scope"])
        return source_cache[key]

    def ref(value, *, expected_id=None, expected_revision=None):
        if not isinstance(value, dict):
            raise RecordError("SEMANTIC_REF")
        source_id = _identifier(value.get("id"))
        revision = value.get("revision")
        if not isinstance(revision, str) or not revision:
            raise RecordError("SEMANTIC_REF")
        if expected_id is not None and (source_id != expected_id or revision != expected_revision):
            raise RecordError("SEMANTIC_REF_TARGET")
        ev = source(source_id, revision)
        locator = value.get("locator")
        if not isinstance(locator, dict):
            raise RecordError("SEMANTIC_LOCATOR")
        # N01 evidence() exposes verified text. Raw-byte coordinate support
        # requires a distinct N01 original-byte locator API and is not claimed.
        if locator.get("coordinate_system") != "unicode_codepoints" or locator.get("source_encoding") != "AFH-representation-text-v1" or locator.get("decoder_version") != "afh-evidence-text-v1":
            raise RecordError("SEMANTIC_LOCATOR_UNSUPPORTED")
        start, end = locator.get("start"), locator.get("end")
        text = ev.get("text")
        if (isinstance(start, bool) or isinstance(end, bool) or
            not isinstance(start, int) or not isinstance(end, int) or
            not isinstance(text, str) or not 0 <= start < end <= len(text)):
            raise RecordError("SEMANTIC_LOCATOR")
        quote = value.get("quote")
        if not isinstance(quote, str) or not quote or text[start:end] != quote:
            raise RecordError("SEMANTIC_SPAN_MISMATCH")
        return ev

    target_ref = unit.get("target_ref")
    target = ref(target_ref)
    issuer = unit.get("issuer")
    if not isinstance(issuer, dict) or issuer.get("role") != target.get("role"):
        raise RecordError("SEMANTIC_ISSUER_ROLE")
    issuer_keys = issuer.get("evidence_keys")
    if not isinstance(issuer_keys, list) or not issuer_keys or any(
        not isinstance(key, str) or not key.startswith("/") for key in issuer_keys
    ):
        raise RecordError("SEMANTIC_ISSUER_EVIDENCE")
    clauses = unit.get("clauses")
    if not isinstance(clauses, list) or not clauses:
        raise RecordError("SEMANTIC_CLAUSES")
    clause_ids, version_ids, expected_manifest = set(), set(), []
    resolutions = {"resolved", "insufficient_context", "ambiguous",
                   "conflicting_evidence", "new_concept_candidate",
                   "not_applicable", "not_stated", "unrepresented"}
    evidential = {"supported", "contradicts", "near_match", "insufficient", "pending"}
    support_states = []
    for clause in clauses:
        if not isinstance(clause, dict):
            raise RecordError("SEMANTIC_CLAUSE")
        cid = _identifier(clause.get("semantic_clause_id"))
        vid = _identifier(clause.get("clause_version_id"))
        if cid in clause_ids or vid in version_ids:
            raise RecordError("SEMANTIC_ID_DUPLICATE")
        clause_ids.add(cid)
        version_ids.add(vid)
        clause_ref = clause.get("target_ref")
        ref(clause_ref, expected_id=target_ref["id"], expected_revision=target_ref["revision"])
        parent_span, child_span = target_ref["locator"], clause_ref["locator"]
        if not (parent_span["start"] <= child_span["start"] < child_span["end"] <= parent_span["end"]):
            raise RecordError("SEMANTIC_REF_TARGET")
        predicate = clause.get("predicate")
        if (not isinstance(predicate, dict) or predicate.get("kind") not in ("catalogue", "provisional_literal")
            or any(not isinstance(predicate.get(key), str) or not predicate[key].strip()
                   for key in ("value", "vocabulary_version"))):
            raise RecordError("SEMANTIC_PREDICATE")
        args = clause.get("arguments")
        if not isinstance(args, list) or not args:
            raise RecordError("SEMANTIC_ARGUMENTS")
        required_keys = {"/issuer/role", "/predicate", "/modality", "/polarity"}
        for index, arg in enumerate(args):
            if not isinstance(arg, dict) or any(
                not isinstance(arg.get(key), str) or not arg[key].strip()
                for key in ("role", "literal")
            ):
                raise RecordError("SEMANTIC_ARGUMENTS")
            required_keys.update((f"/arguments/{index}/role", f"/arguments/{index}/literal"))
            if "interpreted" in arg:
                required_keys.add(f"/arguments/{index}/interpreted")
            if not isinstance(arg.get("evidence_keys"), list) or not arg["evidence_keys"] or any(not isinstance(key, str) or not key.startswith("/") for key in arg["evidence_keys"]):
                raise RecordError("SEMANTIC_ARGUMENT_EVIDENCE")
        if not isinstance(clause.get("resolution"), str) or clause["resolution"] not in resolutions or clause.get("polarity") not in ("positive", "negative", "unresolved"):
            raise RecordError("SEMANTIC_RESOLUTION")
        if clause.get("modality") != payload["modality"]:
            # A mixed-modality source must be split into distinct acts/records.
            raise RecordError("SEMANTIC_MODALITY_MISMATCH")
        if clause.get("applicability") not in ("inspectable_only", "pending_support", "eligible_for_publication"):
            raise RecordError("SEMANTIC_APPLICABILITY")
        verified_support = support_lookup(clause) if callable(support_lookup) else False
        support_states.append(verified_support)
        if clause["applicability"] == "eligible_for_publication" and not verified_support:
            raise RecordError("SEMANTIC_SUPPORT_UNVERIFIED")
        conditions, temporal = clause.get("conditions", []), clause.get("temporal", [])
        if not isinstance(conditions, list) or not isinstance(temporal, list):
            raise RecordError("SEMANTIC_FIELD_SHAPE")
        for index, item in enumerate(conditions):
            if not isinstance(item, dict) or not isinstance(item.get("literal"), str) or not item["literal"] or (not isinstance(item.get("resolution"), str) or item["resolution"] not in ("resolved", "insufficient_context", "ambiguous", "conflicting_evidence", "unrepresented")) or not isinstance(item.get("evidence_keys"), list) or not item["evidence_keys"]:
                raise RecordError("SEMANTIC_CONDITION")
            required_keys.add(f"/conditions/{index}/literal")
            if "ast" in item:
                required_keys.add(f"/conditions/{index}/ast")
        dimensions = {"event", "validity", "system_knowledge", "source_occurrence", "precision_uncertainty", "relative_expression", "ordering_dependency", "claim_evolution", "plan_recurrence", "temporal_provenance"}
        statuses = {"exact", "approximate", "unknown", "not_stated", "not_applicable", "open_bound", "ambiguous"}
        for index, item in enumerate(temporal):
            if not isinstance(item, dict) or (not isinstance(item.get("dimension"), str) or item["dimension"] not in dimensions) or (not isinstance(item.get("status"), str) or item["status"] not in statuses) or not isinstance(item.get("evidence_keys"), list):
                raise RecordError("SEMANTIC_TEMPORAL")
            for field in ("dimension", "status", "literal", "value", "bounds", "anchor_ref", "derivation"):
                if field in item:
                    required_keys.add(f"/temporal/{index}/{field}")
        evidence = clause.get("evidence_by_field")
        if not isinstance(evidence, dict) or not required_keys <= evidence.keys():
            raise RecordError("SEMANTIC_EVIDENCE_MISSING")
        def pointer_exists(pointer):
            if pointer == "/issuer/role":
                return True
            node = clause
            try:
                for part in pointer.split("/")[1:]:
                    part = part.replace("~1", "/").replace("~0", "~")
                    node = node[int(part)] if isinstance(node, list) else node[part]
                return True
            except (KeyError, IndexError, TypeError, ValueError):
                return False
        for key, items in evidence.items():
            if not isinstance(key, str) or not key.startswith("/") or not pointer_exists(key) or not isinstance(items, list) or not items:
                raise RecordError("SEMANTIC_EVIDENCE_POINTER")
            for item in items:
                if not isinstance(item, dict) or (not isinstance(item.get("judgment"), str) or item["judgment"] not in evidential) or item.get("purpose") not in ("target", "context"):
                    raise RecordError("SEMANTIC_EVIDENCE")
                ev = ref({"id": item.get("source_id"), "revision": item.get("revision"),
                          "locator": item.get("locator"), "quote": item.get("quote")})
                if item.get("source_role") != ev.get("role"):
                    raise RecordError("SEMANTIC_EVIDENCE_ROLE")
                if item["purpose"] == "target" and item["source_id"] != target_ref["id"]:
                    raise RecordError("SEMANTIC_EVIDENCE_PURPOSE")
        _typed_shapes(clause, evidence)
        for key in issuer_keys:
            if key not in evidence or not any(
                item["source_id"] == target_ref["id"] and item["purpose"] == "target"
                for item in evidence[key]
            ):
                raise RecordError("SEMANTIC_ISSUER_EVIDENCE")
        for index, arg in enumerate(args):
            if any(key not in evidence for key in arg["evidence_keys"]):
                raise RecordError("SEMANTIC_ARGUMENT_EVIDENCE")
        dependencies = clause.get("dependencies")
        if not isinstance(dependencies, list):
            raise RecordError("SEMANTIC_DEPENDENCIES")
        slots = set()
        for dep in dependencies:
            if not isinstance(dep, dict) or not isinstance(dep.get("slot"), str) or not dep["slot"] or not isinstance(dep.get("field_pointer"), str):
                raise RecordError("SEMANTIC_DEPENDENCIES")
            if dep["slot"] in slots or dep["field_pointer"] not in evidence:
                raise RecordError("SEMANTIC_DEPENDENCIES")
            slots.add(dep["slot"])
            ev = ref(dep.get("source_ref"))
            if not any(item["source_id"] == ev["id"] and item["revision"] == ev["revision"] and item["purpose"] == "context"
                       for item in evidence[dep["field_pointer"]]):
                raise RecordError("SEMANTIC_DEPENDENCY_EVIDENCE")
        for key in ("alternatives", "relations"):
            if key in clause and not isinstance(clause[key], list):
                raise RecordError("SEMANTIC_FIELD_SHAPE", key)
        known = {"semantic_clause_id", "clause_version_id", "target_ref", "predicate", "arguments", "polarity", "modality", "resolution", "evidence_by_field", "dependencies", "applicability", "conditions", "temporal", "alternatives", "relations", "unrepresented_fields"}
        unknown = {"/" + key.replace("~", "~0").replace("/", "~1") for key in clause if key not in known}
        declared = clause.get("unrepresented_fields", [])
        if not isinstance(declared, list) or any(not isinstance(key, str) for key in declared) or unknown != set(declared):
            raise RecordError("SEMANTIC_UNKNOWN_UNDECLARED")
        expected_manifest.append({"semantic_clause_id": cid, "clause_version_id": vid,
                                  "clause_sha256": hashlib.sha256(_json(clause).encode("utf-8")).hexdigest(),
                                  "dependency_slots": sorted(slots)})
    manifest = unit.get("manifest")
    if not isinstance(manifest, dict) or manifest.get("entries") != sorted(expected_manifest, key=lambda x: x["semantic_clause_id"]):
        raise RecordError("SEMANTIC_MANIFEST_MISMATCH")
    if manifest.get("completeness") != unit.get("completeness") or unit.get("completeness") not in ("complete", "partial", "unresolved"):
        raise RecordError("SEMANTIC_COMPLETENESS")
    pending = manifest.get("pending_keys")
    if not isinstance(pending, list) or any(not isinstance(key, str) or not key for key in pending):
        raise RecordError("SEMANTIC_COMPLETENESS")
    # Complete means no material omission/pending dependency or unresolved
    # clause. Independent support cannot erase contradictory manifest state.
    if unit["completeness"] == "complete" and (pending or any(
            c["resolution"] != "resolved" or c["applicability"] == "pending_support"
            or c.get("unrepresented_fields") for c in clauses)):
        raise RecordError("SEMANTIC_COMPLETENESS")
    # Completeness requires independently admitted support for every clause.
    # Legacy declarations alone remain inspectable partial proposals.
    if ((unit["completeness"] == "complete" and not all(support_states))
            or (unit["completeness"] != "complete" and not pending)):
        raise RecordError("SEMANTIC_SUPPORT_UNVERIFIED")
    if unit["completeness"] == "unresolved" and all(c["resolution"] == "resolved" for c in clauses):
        raise RecordError("SEMANTIC_COMPLETENESS")
    return True
