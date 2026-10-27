"""N04 deterministic annotations: source-backed proposals and append-only corrections.

Local caller identity is declared, not authenticated. No model extraction or
semantic truth evaluation occurs here. Original N01 evidence remains authority.
"""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3

from .sqlite_runtime import _deadline_connect
from .sqlite_runtime import QueryAborted
from .postgres_backend import connect as semantic_connect

DEFAULT_RECORDS = None  # explicit candidate database path required
SEMANTIC_TYPES = ("fact", "belief", "preference", "goal", "constraint", "criterion",
                  "policy", "plan", "alternative", "decision", "rationale", "prediction",
                  "action", "outcome", "consequence", "feedback", "question", "unknown")

class RecordError(ValueError):
    def __init__(self, code, detail=""):
        self.code = code
        super().__init__(code + (": " + detail if detail else ""))

def _json(value):
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (ValueError, TypeError) as error:
        raise RecordError("INVALID_JSON", str(error)) from error

def _text(value, name, maximum=20000):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise RecordError("INVALID_FIELD", name)
    return value

def _identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", value):
        raise RecordError("INVALID_ID")
    return value

def approval_statement(payload):
    """Target every payload field except the strictly shaped evidence envelope."""
    semantic = {key: value for key, value in payload.items() if key != "approval"}
    digest = hashlib.sha256(_json(semantic).encode("utf-8")).hexdigest()
    return "Apruebo el registro " + _identifier(payload.get("id")) + " con payload SHA-256 " + digest


class KnowledgeRecords:
    def __init__(self, memory, path, *, read_only=False):
        self.memory, self.path, self.read_only = memory, Path(path).resolve(), read_only
        if not read_only:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = semantic_connect(self.path, read_only=read_only)
        try:
            self.db.row_factory = sqlite3.Row
            if read_only:
                self.db.execute("PRAGMA query_only=ON")
            if not read_only:
                self.db.executescript("""
                    CREATE TABLE IF NOT EXISTS record_versions (
                        record_id TEXT NOT NULL, scope TEXT NOT NULL,
                        version INTEGER NOT NULL, recorded_at TEXT NOT NULL,
                        payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
                        request_id TEXT NOT NULL UNIQUE, request_sha256 TEXT NOT NULL,
                        PRIMARY KEY(record_id, version));
                    CREATE TRIGGER IF NOT EXISTS records_no_update BEFORE UPDATE ON record_versions
                        BEGIN SELECT RAISE(ABORT, 'append only'); END;
                    CREATE TRIGGER IF NOT EXISTS records_no_delete BEFORE DELETE ON record_versions
                        BEGIN SELECT RAISE(ABORT, 'append only'); END;
                    CREATE TABLE IF NOT EXISTS semantic_support_admissions (
                        record_id TEXT NOT NULL, version INTEGER NOT NULL, payload_sha256 TEXT NOT NULL,
                        packet_json TEXT NOT NULL, receipt_raw TEXT NOT NULL, receipt_sha256 TEXT NOT NULL,
                        reviewer_task_id TEXT NOT NULL, producer_task_id TEXT NOT NULL,
                        context_cut_json TEXT NOT NULL, review_request_sha256 TEXT NOT NULL,
                        PRIMARY KEY(record_id,version,receipt_sha256));
                    CREATE TRIGGER IF NOT EXISTS support_no_update BEFORE UPDATE ON semantic_support_admissions
                        BEGIN SELECT RAISE(ABORT, 'append only'); END;
                    CREATE TRIGGER IF NOT EXISTS support_no_delete BEFORE DELETE ON semantic_support_admissions
                        BEGIN SELECT RAISE(ABORT, 'append only'); END;
                    CREATE TABLE IF NOT EXISTS semantic_act_identity (
                        scope TEXT NOT NULL, act_id TEXT NOT NULL, record_id TEXT NOT NULL,
                        PRIMARY KEY(scope,act_id));
                    CREATE TRIGGER IF NOT EXISTS semantic_act_no_update BEFORE UPDATE ON semantic_act_identity
                        BEGIN SELECT RAISE(ABORT, 'append only'); END;
                    CREATE TABLE IF NOT EXISTS semantic_clause_identity (
                        scope TEXT NOT NULL, semantic_clause_id TEXT NOT NULL,
                        act_id TEXT NOT NULL, record_id TEXT NOT NULL,
                        PRIMARY KEY(scope,semantic_clause_id));
                    CREATE TABLE IF NOT EXISTS semantic_clause_versions (
                        scope TEXT NOT NULL, clause_version_id TEXT NOT NULL,
                        semantic_clause_id TEXT NOT NULL, clause_sha256 TEXT NOT NULL,
                        PRIMARY KEY(scope,clause_version_id));
                    CREATE TRIGGER IF NOT EXISTS semantic_identity_no_update BEFORE UPDATE ON semantic_clause_identity
                        BEGIN SELECT RAISE(ABORT, 'append only'); END;
                    CREATE TRIGGER IF NOT EXISTS semantic_versions_no_update BEFORE UPDATE ON semantic_clause_versions
                        BEGIN SELECT RAISE(ABORT, 'append only'); END;
                    CREATE TRIGGER IF NOT EXISTS semantic_act_no_delete BEFORE DELETE ON semantic_act_identity
                        BEGIN SELECT RAISE(ABORT, 'append only'); END;
                    CREATE TRIGGER IF NOT EXISTS semantic_identity_no_delete BEFORE DELETE ON semantic_clause_identity
                        BEGIN SELECT RAISE(ABORT, 'append only'); END;
                    CREATE TRIGGER IF NOT EXISTS semantic_versions_no_delete BEFORE DELETE ON semantic_clause_versions
                        BEGIN SELECT RAISE(ABORT, 'append only'); END;
                """)
                self.db.executescript("""
                    CREATE INDEX IF NOT EXISTS records_scope_time ON record_versions(scope,recorded_at,record_id,version);
                    CREATE TABLE IF NOT EXISTS record_integrity_policy (
                        singleton INTEGER PRIMARY KEY CHECK(singleton=1), legacy_max_rowid INTEGER NOT NULL);
                    INSERT OR IGNORE INTO record_integrity_policy SELECT 1, COALESCE(MAX(rowid),0) FROM record_versions;
                    CREATE TABLE IF NOT EXISTS record_envelopes (
                        record_rowid INTEGER PRIMARY KEY, digest_version INTEGER NOT NULL, digest TEXT NOT NULL);
                    CREATE TRIGGER IF NOT EXISTS envelopes_no_update BEFORE UPDATE ON record_envelopes
                        BEGIN SELECT RAISE(ABORT, 'append only'); END;
                    CREATE TRIGGER IF NOT EXISTS envelopes_no_delete BEFORE DELETE ON record_envelopes
                        BEGIN SELECT RAISE(ABORT, 'append only'); END;
                    CREATE TABLE IF NOT EXISTS g1_projection_outbox (
                        outbox_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
                        record_id TEXT NOT NULL, record_version INTEGER NOT NULL, scope TEXT NOT NULL,
                        source_cut TEXT NOT NULL, authorization_snapshot TEXT NOT NULL,
                        payload_sha256 TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
                        UNIQUE(record_id,record_version));
                    CREATE TRIGGER IF NOT EXISTS g1_outbox_no_update BEFORE UPDATE ON g1_projection_outbox
                        BEGIN SELECT RAISE(ABORT, 'append only'); END;
                    CREATE TRIGGER IF NOT EXISTS g1_outbox_no_delete BEFORE DELETE ON g1_projection_outbox
                        BEGIN SELECT RAISE(ABORT, 'append only'); END;
                    CREATE TABLE IF NOT EXISTS g1_projection_events (
                        outbox_id TEXT NOT NULL, sequence INTEGER NOT NULL, state TEXT NOT NULL,
                        generation_id TEXT, fence_token INTEGER NOT NULL, detail_json TEXT NOT NULL,
                        recorded_at TEXT NOT NULL, PRIMARY KEY(outbox_id,sequence));
                    CREATE TRIGGER IF NOT EXISTS g1_events_no_update BEFORE UPDATE ON g1_projection_events
                        BEGIN SELECT RAISE(ABORT, 'append only'); END;
                    CREATE TRIGGER IF NOT EXISTS g1_events_no_delete BEFORE DELETE ON g1_projection_events
                        BEGIN SELECT RAISE(ABORT, 'append only'); END;
                """)
            self.has_envelopes = self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_integrity_policy'").fetchone() is not None
            self.has_semantic_map = all(self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None for name in ("semantic_act_identity", "semantic_clause_identity", "semantic_clause_versions"))
        except BaseException:
            # Ownership starts at connect, before the caller can register close.
            self.db.close()
            raise
    def _semantic_support_verified(self, payload, clause):
        from .semantic_support import verified_clause_support
        return verified_clause_support(self, payload, clause)

    def close(self):
        self.db.close()
    def _source(self, ref, scope):
        if not isinstance(ref, dict) or not isinstance(ref.get("id"), str) or not isinstance(ref.get("revision"), str):
            raise RecordError("SOURCE_REQUIRED")
        # Scope eligibility is checked before opening any original bytes.
        if callable(getattr(self.memory, "source_eligible", None)):
            eligible = self.memory.source_eligible(ref["id"], scope)
        else:
            eligible = self.memory.db.execute("SELECT 1 FROM records r JOIN occurrences o ON o.revision=r.revision WHERE r.id=? AND o.project=? LIMIT 1", (ref["id"],scope)).fetchone() is not None
        if not eligible:
            raise RecordError("SOURCE_SCOPE_MISMATCH")
        try:
            evidence = self.memory.evidence(ref["id"])
        except QueryAborted:
            raise
        except Exception as error:
            raise RecordError("SOURCE_UNAVAILABLE", str(error)) from error
        if evidence.get("lookup_status", "complete") != "complete":
            raise RecordError("SOURCE_UNAVAILABLE", "Federated source lookup incomplete")
        if evidence.get("revision") != ref["revision"] or evidence.get("verified") is not True:
            raise RecordError("SOURCE_REVISION_MISMATCH")
        projects = {item.get("project") for item in evidence.get("occurrences", [])}
        if not projects:
            projects = {evidence.get("project")}
        if scope not in projects:
            raise RecordError("SOURCE_SCOPE_MISMATCH")
        return evidence
    def _validate(self, payload, *, verify_sources=True, source_lookup=None):
        if source_lookup is None:
            source_lookup = self._source
        if not isinstance(payload, dict):
            raise RecordError("INVALID_RECORD")
        _identifier(payload.get("id"))
        _text(payload.get("scope"), "scope", 128)
        _text(payload.get("type"), "type", 128)  # Unknown labels are preserved verbatim.
        _text(payload.get("text"), "text")
        actor = payload.get("actor")
        if not isinstance(actor, dict):
            raise RecordError("ACTOR_REQUIRED")
        _text(actor.get("id"), "actor.id", 128)
        if actor.get("role") not in ("user", "agent", "system", "unknown"):
            raise RecordError("INVALID_ACTOR_ROLE")
        if payload.get("modality") not in ("assertion", "directive", "inference", "instruction", "hypothesis", "question", "unknown", "stated", "observed", "inferred", "hypothetical", "negated", "uncertain"):
            raise RecordError("INVALID_MODALITY")
        refs = payload.get("source_refs")
        if not isinstance(refs, list) or not 1 <= len(refs) <= 20:
            raise RecordError("SOURCE_REQUIRED")
        for ref in refs:
            if not isinstance(ref, dict) or not isinstance(ref.get("id"),str) or not isinstance(ref.get("revision"),str):
                raise RecordError("SOURCE_REQUIRED")
            if verify_sources:
                source_lookup(ref, payload["scope"])
        status = payload.get("status")
        if status not in ("proposed", "approved"):
            raise RecordError("INVALID_STATUS")
        if status == "approved":
            if payload["modality"] in ("inference", "inferred") or actor["role"] != "user":
                raise RecordError("APPROVAL_REQUIRED", "agent inference cannot become approval")
            approval = payload.get("approval")
            if not isinstance(approval, dict) or set(approval) != {"source_ref", "quote"}:
                raise RecordError("APPROVAL_REQUIRED")
            source = source_lookup(approval.get("source_ref"), payload["scope"]) if verify_sources else None
            quote = approval.get("quote")
            expected = approval_statement(payload)
            if quote != expected or (verify_sources and (source.get("role") != "user" or source["text"].strip() not in (quote, "user\n" + quote))):
                raise RecordError("APPROVAL_REQUIRED", "standalone targeted user payload-hash statement required")
        contradictions = payload.get("contradicts", [])
        if not isinstance(contradictions, list) or len(contradictions) > 100:
            raise RecordError("INVALID_CONTRADICTIONS")
        for record_id in contradictions:
            _identifier(record_id)
        if "graph" in payload:
            from afh_semantic.relational_memory import validate_graph
            validate_graph(payload)
        if isinstance(payload.get("semantic_unit"), dict) and payload["semantic_unit"].get("schema_version") == "noetis.semantic-act.v1":
            from afh_semantic.semantic_units import validate_semantic_unit
            from afh_semantic.semantic_support import verified_clause_support
            validate_semantic_unit(payload, source_lookup,
                support_lookup=lambda clause: verified_clause_support(self, payload, clause))
        _json(payload)
    @staticmethod
    def _envelope_digest(row):
        fields = ("record_id","scope","version","recorded_at","payload","payload_sha256","request_id","request_sha256")
        return hashlib.sha256(_json({key:row[key] for key in fields}).encode("utf-8")).hexdigest()
    def _envelope(self, row, *, verify_sources=True, source_lookup=None):
        integrity = "legacy_payload_only"
        if self.has_envelopes:
            seal = self.db.execute("SELECT * FROM record_envelopes WHERE record_rowid=?",(row["_rowid"],)).fetchone()
            boundary = self.db.execute("SELECT legacy_max_rowid FROM record_integrity_policy WHERE singleton=1").fetchone()
            if boundary is None:
                raise RecordError("RECORD_CORRUPT", "integrity policy missing")
            if seal:
                if seal["digest_version"] != 1 or seal["digest"] != self._envelope_digest(row):
                    raise RecordError("RECORD_CORRUPT", "envelope differs")
                integrity = "envelope_v1"
            elif row["_rowid"] > boundary[0]:
                raise RecordError("RECORD_CORRUPT", "envelope missing")
        if hashlib.sha256(row["payload"].encode()).hexdigest() != row["payload_sha256"]:
            raise RecordError("RECORD_CORRUPT")
        payload = json.loads(row["payload"])
        if payload.get("id") != row["record_id"] or payload.get("scope") != row["scope"]:
            raise RecordError("RECORD_CORRUPT")
        self._validate(payload, verify_sources=verify_sources, source_lookup=source_lookup)
        unit = payload.get("semantic_unit")
        if isinstance(unit, dict) and unit.get("schema_version") == "noetis.semantic-act.v1":
            if not self.has_semantic_map:
                raise RecordError("SEMANTIC_IDMAP_MISSING")
            act = self.db.execute("SELECT record_id FROM semantic_act_identity WHERE scope=? AND act_id=?", (payload["scope"],unit["act_id"])).fetchone()
            if act is None or act["record_id"] != payload["id"]:
                raise RecordError("SEMANTIC_ACT_IDMAP_MISMATCH")
            for entry in unit["manifest"]["entries"]:
                cid, vid, digest = entry["semantic_clause_id"], entry["clause_version_id"], entry["clause_sha256"]
                identity = self.db.execute("SELECT act_id,record_id FROM semantic_clause_identity WHERE scope=? AND semantic_clause_id=?", (payload["scope"],cid)).fetchone()
                version = self.db.execute("SELECT semantic_clause_id,clause_sha256 FROM semantic_clause_versions WHERE scope=? AND clause_version_id=?", (payload["scope"],vid)).fetchone()
                if identity is None or (identity["act_id"],identity["record_id"]) != (unit["act_id"],payload["id"]) or version is None or (version["semantic_clause_id"],version["clause_sha256"]) != (cid,digest):
                    raise RecordError("SEMANTIC_IDMAP_MISMATCH")
        return {"integrity":integrity, "id":row["record_id"], "version":row["version"], "recorded_at":row["recorded_at"], "payload":payload}
    def _insert_g1_outbox(self, row, payload):
        unit = payload.get("semantic_unit")
        if not isinstance(unit, dict) or unit.get("schema_version") != "noetis.semantic-act.v1":
            return None
        cut = unit["context_cut"]
        manifest_sha256 = hashlib.sha256(_json(unit["manifest"]).encode("utf-8")).hexdigest()
        outbox_id = "g1o_" + hashlib.sha256(_json([row["request_id"], row["record_id"], row["version"],
            row["payload_sha256"], cut["source_cut"], cut["authorization_snapshot"]]).encode("utf-8")).hexdigest()
        self.db.execute(
            "INSERT INTO g1_projection_outbox VALUES(?,?,?,?,?,?,?,?,?,?)",
            (outbox_id, row["request_id"], row["record_id"], row["version"], row["scope"],
             cut["source_cut"], cut["authorization_snapshot"], row["payload_sha256"],
             manifest_sha256, row["recorded_at"]))
        self.db.execute(
            "INSERT INTO g1_projection_events VALUES(?,?,?,NULL,0,?,?)",
            (outbox_id, 1, "planned", _json({"origin": "same_n04_transaction"}), row["recorded_at"]))
        return outbox_id

    def put(self, payload, *, expected_version, request_id):
        if self.read_only:
            raise RecordError("READ_ONLY")
        _identifier(request_id)
        if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version < 0:
            raise RecordError("INVALID_VERSION")
        self._validate(payload)
        encoded = _json(payload)
        request_hash = hashlib.sha256(_json([payload, expected_version]).encode()).hexdigest()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            if hasattr(self, '_afh_generation_guard'): self._afh_generation_guard()
            previous_request = self.db.execute("SELECT rowid AS _rowid, * FROM record_versions WHERE request_id=?", (request_id,)).fetchone()
            if previous_request:
                if previous_request["request_sha256"] != request_hash:
                    raise RecordError("IDEMPOTENCY_CONFLICT")
                result = self._envelope(previous_request)
                self.db.commit()
                return result
            from afh_semantic.semantic_units import validate_new_temporal_bounds
            validate_new_temporal_bounds(payload)
            prior = self.db.execute("SELECT rowid AS _rowid, * FROM record_versions WHERE record_id=? ORDER BY version DESC LIMIT 1", (payload["id"],)).fetchone()
            if prior and prior["scope"] != payload["scope"]:
                raise RecordError("SCOPE_CONFLICT")
            if (prior["version"] if prior else 0) != expected_version:
                raise RecordError("VERSION_CONFLICT")
            if prior:
                self._envelope(prior)
                old = json.loads(prior["payload"])
                old_unit, new_unit = old.get("semantic_unit"), payload.get("semantic_unit")
                old_act = old_unit.get("act_id") if isinstance(old_unit, dict) and old_unit.get("schema_version") == "noetis.semantic-act.v1" else None
                new_act = new_unit.get("act_id") if isinstance(new_unit, dict) and new_unit.get("schema_version") == "noetis.semantic-act.v1" else None
                if old_act != new_act:
                    raise RecordError("SEMANTIC_ACT_LINEAGE")
                old_graph, new_graph = old.get("graph"), payload.get("graph")
                if old_graph or new_graph:
                    keys = ("kind","subject","predicate","object")
                    if old_graph is None or new_graph is None or any(old_graph.get(key) != new_graph.get(key) for key in keys):
                        raise RecordError("LINEAGE_CONFLICT")
            unit = payload.get("semantic_unit")
            if isinstance(unit, dict) and unit.get("schema_version") == "noetis.semantic-act.v1":
                act = self.db.execute("SELECT record_id FROM semantic_act_identity WHERE scope=? AND act_id=?", (payload["scope"],unit["act_id"])).fetchone()
                if act and act["record_id"] != payload["id"]:
                    raise RecordError("SEMANTIC_ACT_IDENTITY_CONFLICT")
                if not act:
                    self.db.execute("INSERT INTO semantic_act_identity VALUES(?,?,?)", (payload["scope"],unit["act_id"],payload["id"]))
                for entry in unit["manifest"]["entries"]:
                    cid, vid, digest = entry["semantic_clause_id"], entry["clause_version_id"], entry["clause_sha256"]
                    identity = self.db.execute("SELECT act_id,record_id FROM semantic_clause_identity WHERE scope=? AND semantic_clause_id=?", (payload["scope"],cid)).fetchone()
                    if identity and (identity["act_id"],identity["record_id"]) != (unit["act_id"],payload["id"]):
                        raise RecordError("SEMANTIC_IDENTITY_CONFLICT")
                    version = self.db.execute("SELECT semantic_clause_id,clause_sha256 FROM semantic_clause_versions WHERE scope=? AND clause_version_id=?", (payload["scope"],vid)).fetchone()
                    if version and (version["semantic_clause_id"],version["clause_sha256"]) != (cid,digest):
                        raise RecordError("SEMANTIC_VERSION_CONFLICT")
                    if not identity:
                        self.db.execute("INSERT INTO semantic_clause_identity VALUES(?,?,?,?)", (payload["scope"],cid,unit["act_id"],payload["id"]))
                    if not version:
                        self.db.execute("INSERT INTO semantic_clause_versions VALUES(?,?,?,?)", (payload["scope"],vid,cid,digest))
            if payload.get("graph",{}).get("kind") == "relation":
                for endpoint in (payload["graph"]["subject"],payload["graph"]["object"]):
                    target = self.get(endpoint,payload["scope"])
                    if target["integrity"] != "envelope_v1" or target["payload"].get("graph",{}).get("kind") != "entity":
                        raise RecordError("ENDPOINT_INVALID")
            for target in payload.get("contradicts", []):
                row = self.db.execute("SELECT scope FROM record_versions WHERE record_id=? LIMIT 1", (target,)).fetchone()
                if row is None or row["scope"] != payload["scope"]:
                    raise RecordError("CONTRADICTION_TARGET_INVALID")
            now = datetime.now(timezone.utc).isoformat(timespec="microseconds")
            latest = self.db.execute("SELECT recorded_at FROM record_versions ORDER BY rowid DESC LIMIT 1").fetchone()
            if latest and now < latest[0]:
                raise RecordError("CLOCK_REGRESSION")
            self.db.execute("INSERT INTO record_versions VALUES(?,?,?,?,?,?,?,?)", (payload["id"],payload["scope"],expected_version+1,now,encoded,hashlib.sha256(encoded.encode()).hexdigest(),request_id,request_hash))
            row = self.db.execute("SELECT rowid AS _rowid, * FROM record_versions WHERE record_id=? AND version=?", (payload["id"],expected_version+1)).fetchone()
            self.db.execute("INSERT INTO record_envelopes VALUES(?,1,?)", (row["_rowid"],self._envelope_digest(row)))
            for admission in getattr(self, '_pending_support_admission', []):
                if (admission['record_id'] != row['record_id'] or admission['version'] != row['version']
                        or admission['payload_sha256'] != row['payload_sha256']):
                    raise RecordError('SUPPORT_RECEIPT_BINDING')
                self.db.execute("INSERT INTO semantic_support_admissions VALUES(?,?,?,?,?,?,?,?,?,?)",
                    tuple(admission[key] for key in ('record_id','version','payload_sha256','packet_json',
                        'receipt_raw','receipt_sha256','reviewer_task_id','producer_task_id',
                        'context_cut_json','review_request_sha256')))
            result = self._envelope(row)
            self._insert_g1_outbox(row, payload)
            self.db.commit()
            return result
        except Exception:
            self.db.rollback()
            raise
    def g1_outbox_entry(self, outbox_id):
        row = self.db.execute("SELECT * FROM g1_projection_outbox WHERE outbox_id=?", (outbox_id,)).fetchone()
        if row is None:
            raise RecordError("G1_OUTBOX_NOT_FOUND")
        events = self.db.execute(
            "SELECT * FROM g1_projection_events WHERE outbox_id=? ORDER BY sequence", (outbox_id,)).fetchall()
        if not events:
            raise RecordError("G1_OUTBOX_CORRUPT")
        latest = events[-1]
        return {**dict(row), "state": latest["state"], "generation_id": latest["generation_id"],
                "fence_token": latest["fence_token"], "sequence": latest["sequence"],
                "detail": json.loads(latest["detail_json"]),
                "events": [dict(event) for event in events]}

    def latest_g1_outbox(self, scope, source_cut=None):
        _text(scope, "scope", 128)
        sql = "SELECT outbox_id FROM g1_projection_outbox WHERE scope=?"
        args = [scope]
        if source_cut is not None:
            _text(source_cut, "source_cut", 512)
            sql += " AND source_cut=?"
            args.append(source_cut)
        sql += " ORDER BY created_at DESC,record_version DESC,outbox_id DESC LIMIT 1"
        row = self.db.execute(sql, args).fetchone()
        return None if row is None else self.g1_outbox_entry(row["outbox_id"])

    def g1_generation_members(self, outbox_id, *, limit=100):
        """Exact latest act versions at the anchor's commit, never later appends.

        Reuse the atomic N04/outbox boundary; no mutable batch catalogue. A
        generation's anchor row fixes its member set even across failure/replay.
        """
        anchor = self.g1_outbox_entry(outbox_id)
        bound = self.db.execute(
            "SELECT rowid FROM record_versions WHERE record_id=? AND version=? AND scope=?",
            (anchor["record_id"], anchor["record_version"], anchor["scope"])).fetchone()
        if bound is None:
            raise RecordError("G1_N04_BINDING_MISMATCH")
        rows = self.db.execute(
            "SELECT r.record_id,r.version FROM record_versions r JOIN "
            "(SELECT record_id,MAX(version) AS version FROM record_versions "
            "WHERE scope=? AND rowid<=? AND recorded_at<=? GROUP BY record_id) latest "
            "ON latest.record_id=r.record_id AND latest.version=r.version "
            "WHERE r.scope=? ORDER BY r.record_id LIMIT ?",
            (anchor["scope"], bound[0], anchor["created_at"], anchor["scope"], limit+1)).fetchall()
        if len(rows) > limit:
            raise RecordError("G1_GENERATION_COVERAGE_LIMIT")
        members = []
        for row in rows:
            item = self.db.execute(
                "SELECT outbox_id FROM g1_projection_outbox WHERE scope=? AND record_id=? "
                "AND record_version=? AND source_cut=?",
                (anchor["scope"], row["record_id"], row["version"], anchor["source_cut"])).fetchone()
            if item is None:
                continue  # Ordinary records and other cuts are outside this projection.
            entry = self.g1_outbox_entry(item["outbox_id"])
            if entry["authorization_snapshot"] != anchor["authorization_snapshot"]:
                raise RecordError("G1_AUTHORIZATION_SNAPSHOT_MISMATCH")
            members.append(entry)
        if not any(item["outbox_id"] == outbox_id for item in members):
            raise RecordError("G1_N04_BINDING_MISMATCH")
        return members

    def historical_g1_outbox(self, scope, generation_id, known_at, *, source_cut=None):
        """A selected publication actually known at the supplied instant.

        Current access is still verified by get(); historical knowledge never
        bypasses source withdrawal. The current selector is deliberately separate.
        """
        _text(scope, "scope", 128)
        _identifier(generation_id)
        try:
            if not isinstance(known_at, str) or known_at.endswith("-00:00"):
                raise ValueError("known timezone required")
            instant = datetime.fromisoformat(known_at)
            if instant.tzinfo is None:
                raise ValueError("timezone required")
            instant = instant.astimezone(timezone.utc).isoformat(timespec="microseconds")
        except (TypeError, ValueError) as error:
            raise RecordError("G1_KNOWN_AT_INVALID") from error
        rows = self.db.execute(
            "SELECT o.outbox_id,e.recorded_at AS selected_at FROM g1_projection_outbox o "
            "JOIN g1_projection_events e ON o.outbox_id=e.outbox_id "
            "WHERE o.scope=? AND e.state='selected' AND e.generation_id=? AND e.recorded_at<=? "
            "AND o.created_at<=? ORDER BY e.recorded_at DESC LIMIT 2",
            (scope, generation_id, instant, instant)).fetchall()
        if not rows:
            raise RecordError("G1_HISTORY_NOT_AVAILABLE")
        if len(rows) != 1:
            raise RecordError("G1_N04_BINDING_MISMATCH")
        entry = self.g1_outbox_entry(rows[0]["outbox_id"])
        if source_cut is not None and source_cut != entry["source_cut"]:
            raise RecordError("G1_CUT_MISMATCH")
        if entry["state"] != "selected" or entry["generation_id"] != generation_id:
            raise RecordError("G1_HISTORY_NOT_AVAILABLE")
        if rows[0]["selected_at"] < entry["created_at"]:
            raise RecordError("G1_PUBLICATION_CLOCK_REGRESSION")
        return {**entry, "selected_at": rows[0]["selected_at"], "known_at": instant}

    def _g1_newer_selected(self, record):
        # Row order breaks equal wall-clock timestamps without backdating or
        # changing lifecycle states. This is checked inside the writer transaction.
        return self.db.execute(
            "SELECT 1 FROM g1_projection_outbox o JOIN g1_projection_events e "
            "ON o.outbox_id=e.outbox_id JOIN record_versions newer "
            "ON newer.record_id=o.record_id AND newer.version=o.record_version "
            "JOIN record_versions anchor ON anchor.record_id=? AND anchor.version=? "
            "WHERE o.scope=? AND o.source_cut=? AND e.state='selected' "
            "AND newer.rowid>anchor.rowid LIMIT 1",
            (record["record_id"], record["record_version"], record["scope"], record["source_cut"])).fetchone() is not None

    def begin_g1_projection(self, outbox_id, generation_id, *, expected_state=None,
                           expected_sequence=None, expected_fence_token=None):
        if self.read_only:
            raise RecordError("READ_ONLY")
        _identifier(outbox_id)
        _identifier(generation_id)
        expected = (expected_state, expected_sequence, expected_fence_token)
        if any(value is not None for value in expected) and any(value is None for value in expected):
            raise RecordError("G1_EXPECTED_STATE_REQUIRED")
        self.db.execute("BEGIN IMMEDIATE")
        try:
            record = self.db.execute("SELECT * FROM g1_projection_outbox WHERE outbox_id=?", (outbox_id,)).fetchone()
            if record is None:
                raise RecordError("G1_OUTBOX_NOT_FOUND")
            events = self.db.execute(
                "SELECT * FROM g1_projection_events WHERE outbox_id=? ORDER BY sequence", (outbox_id,)).fetchall()
            if not events:
                raise RecordError("G1_OUTBOX_CORRUPT")
            latest = events[-1]
            if (expected_state is not None
                    and (latest["state"] != expected_state or latest["sequence"] != expected_sequence
                         or latest["fence_token"] != expected_fence_token)):
                raise RecordError("G1_FENCE_OR_STATE_STALE")
            if latest["state"] == "selected":
                if latest["generation_id"] != generation_id:
                    raise RecordError("G1_GENERATION_CONFLICT")
                self.db.commit()
                return self.g1_outbox_entry(outbox_id)
            if latest["generation_id"] not in (None, generation_id):
                raise RecordError("G1_GENERATION_CONFLICT")
            if self._g1_newer_selected(record):
                raise RecordError("G1_OUTBOX_SUPERSEDED")
            highest = self.db.execute(
                "SELECT COALESCE(MAX(e.fence_token),0) AS value FROM g1_projection_events e "
                "JOIN g1_projection_outbox o ON o.outbox_id=e.outbox_id "
                "WHERE o.scope=? AND o.source_cut=?", (record["scope"], record["source_cut"])).fetchone()["value"]
            if latest["state"] in ("upserting", "counts_verified", "marker_visible"):
                if expected_state is None:
                    raise RecordError("G1_TRANSITION_CONFLICT")
                if latest["fence_token"] != highest:
                    raise RecordError("G1_FENCE_OR_STATE_STALE")
                self.db.commit()
                return self.g1_outbox_entry(outbox_id)
            if latest["state"] not in ("planned", "failed"):
                raise RecordError("G1_TRANSITION_CONFLICT")
            fence = highest + 1
            self.db.execute(
                "INSERT INTO g1_projection_events VALUES(?,?,?,?,?,?,?)",
                (outbox_id, latest["sequence"]+1, "upserting", generation_id, fence,
                 _json({"started_after": latest["state"]}), datetime.now(timezone.utc).isoformat(timespec="microseconds")))
            self.db.commit()
            return self.g1_outbox_entry(outbox_id)
        except Exception:
            self.db.rollback()
            raise
    def advance_g1_projection(self, outbox_id, *, expected_state, state, generation_id, fence_token, detail=None):
        if self.read_only:
            raise RecordError("READ_ONLY")
        allowed = {
            "upserting": {"counts_verified", "failed"},
            "counts_verified": {"marker_visible", "failed"},
            "marker_visible": {"readback_verified", "failed"},
            "readback_verified": {"receipt_durable", "failed"},
            "receipt_durable": set(),
        }
        if state not in allowed.get(expected_state, set()):
            raise RecordError("G1_TRANSITION_INVALID")
        if isinstance(fence_token, bool) or not isinstance(fence_token, int) or fence_token < 1:
            raise RecordError("G1_FENCE_INVALID")
        _identifier(outbox_id)
        _identifier(generation_id)
        detail_json = _json(detail or {})
        self.db.execute("BEGIN IMMEDIATE")
        try:
            record = self.db.execute(
                "SELECT * FROM g1_projection_outbox WHERE outbox_id=?", (outbox_id,)).fetchone()
            if record is None:
                raise RecordError("G1_OUTBOX_NOT_FOUND")
            events = self.db.execute(
                "SELECT * FROM g1_projection_events WHERE outbox_id=? ORDER BY sequence", (outbox_id,)).fetchall()
            if not events:
                raise RecordError("G1_OUTBOX_NOT_FOUND")
            latest = events[-1]
            if (latest["state"] != expected_state or latest["generation_id"] != generation_id
                    or latest["fence_token"] != fence_token):
                raise RecordError("G1_FENCE_OR_STATE_STALE")
            highest = self.db.execute(
                "SELECT COALESCE(MAX(e.fence_token),0) AS value FROM g1_projection_events e "
                "JOIN g1_projection_outbox o ON o.outbox_id=e.outbox_id "
                "WHERE o.scope=? AND o.source_cut=?", (record["scope"], record["source_cut"])).fetchone()["value"]
            if latest["fence_token"] != highest:
                raise RecordError("G1_FENCE_OR_STATE_STALE")
            self.db.execute(
                "INSERT INTO g1_projection_events VALUES(?,?,?,?,?,?,?)",
                (outbox_id, latest["sequence"]+1, state, generation_id, fence_token, detail_json,
                 datetime.now(timezone.utc).isoformat(timespec="microseconds")))
            self.db.commit()
            return self.g1_outbox_entry(outbox_id)
        except Exception:
            self.db.rollback()
            raise

    def select_g1_projection(self, outbox_id, *, generation_id, fence_token,
                             receipt_sha256, select_graph):
        if self.read_only:
            raise RecordError("READ_ONLY")
        _identifier(outbox_id)
        _identifier(generation_id)
        if (isinstance(fence_token, bool) or not isinstance(fence_token, int) or fence_token < 1
                or not re.fullmatch(r"[a-f0-9]{64}", str(receipt_sha256))
                or not callable(select_graph)):
            raise RecordError("G1_FENCE_INVALID")
        self.db.execute("BEGIN IMMEDIATE")
        try:
            record = self.db.execute(
                "SELECT * FROM g1_projection_outbox WHERE outbox_id=?", (outbox_id,)).fetchone()
            if record is None:
                raise RecordError("G1_OUTBOX_NOT_FOUND")
            events = self.db.execute(
                "SELECT * FROM g1_projection_events WHERE outbox_id=? ORDER BY sequence", (outbox_id,)).fetchall()
            if not events:
                raise RecordError("G1_OUTBOX_CORRUPT")
            latest = events[-1]
            detail = json.loads(latest["detail_json"])
            if latest["state"] != "receipt_durable" or latest["generation_id"] != generation_id:
                raise RecordError("G1_FENCE_OR_STATE_STALE")
            if latest["fence_token"] != fence_token or detail.get("receipt_sha256") != receipt_sha256:
                raise RecordError("G1_FENCE_OR_STATE_STALE")
            highest = self.db.execute(
                "SELECT COALESCE(MAX(e.fence_token),0) AS value FROM g1_projection_events e "
                "JOIN g1_projection_outbox o ON o.outbox_id=e.outbox_id "
                "WHERE o.scope=? AND o.source_cut=?", (record["scope"], record["source_cut"])).fetchone()["value"]
            if highest != fence_token:
                raise RecordError("G1_FENCE_OR_STATE_STALE")
            if self._g1_newer_selected(record):
                raise RecordError("G1_OUTBOX_SUPERSEDED")
            floor = max(record["created_at"], latest["recorded_at"])
            if datetime.now(timezone.utc).isoformat(timespec="microseconds") < floor:
                raise RecordError("G1_PUBLICATION_CLOCK_REGRESSION")
            select_graph()
            selected_at = datetime.now(timezone.utc).isoformat(timespec="microseconds")
            if selected_at < floor:
                # A backend selector alone still does not expose history; the
                # receipt-durable outbox remains pending and can resume safely.
                raise RecordError("G1_PUBLICATION_CLOCK_REGRESSION")
            self.db.execute(
                "INSERT INTO g1_projection_events VALUES(?,?,?,?,?,?,?)",
                (outbox_id, latest["sequence"]+1, "selected", generation_id, fence_token,
                 _json({"receipt_sha256": receipt_sha256}), selected_at))
            self.db.commit()
            return self.g1_outbox_entry(outbox_id)
        except BaseException:
            self.db.rollback()
            raise
    def get(self, record_id, scope, *, version=None):
        _identifier(record_id)
        _text(scope, "scope", 128)
        if version is not None and (isinstance(version, bool) or not isinstance(version, int) or version < 1):
            raise RecordError("INVALID_VERSION")
        row = self.db.execute("SELECT rowid AS _rowid, * FROM record_versions WHERE record_id=? AND scope=?" + (" AND version=?" if version is not None else "") + " ORDER BY version DESC LIMIT 1", (record_id,scope,version) if version is not None else (record_id,scope)).fetchone()
        if row is None:
            raise RecordError("NOT_FOUND")
        return self._envelope(row)
    def history(self, record_id, scope):
        self.get(record_id, scope)
        return [self._envelope(row) for row in self.db.execute("SELECT rowid AS _rowid, * FROM record_versions WHERE record_id=? AND scope=? ORDER BY version", (record_id,scope))]
    def search(self, query, scope, *, as_of=None, limit=100, max_rowid=None):
        if not isinstance(query, str) or len(query) > 512:
            raise RecordError("INVALID_QUERY")
        _text(scope, "scope", 128)
        if isinstance(limit, bool) or not isinstance(limit,int) or not 1 <= limit <= (101 if max_rowid is not None else 100):
            raise RecordError("INVALID_LIMIT")
        if as_of is not None:
            try:
                if isinstance(as_of, str) and as_of.endswith("-00:00"):
                    raise ValueError("unknown timezone is not an instant")
                parsed=datetime.fromisoformat(as_of)
                if parsed.tzinfo is None: raise ValueError("timezone required")
                as_of=parsed.astimezone(timezone.utc).isoformat(timespec="microseconds")
            except (TypeError,ValueError) as error:
                raise RecordError("INVALID_AS_OF") from error
        if max_rowid is not None and (isinstance(max_rowid, bool) or not isinstance(max_rowid, int) or max_rowid < 0):
            raise RecordError("INVALID_ROWID_CUT")
        # A rowid cut keeps independent current-record reads on one committed
        # selection boundary without holding a read transaction across source I/O.
        filters = ""
        args = [scope]
        if as_of is not None:
            filters += " AND recorded_at<=?"
            args.append(as_of)
        if max_rowid is not None:
            filters += " AND rowid<=?"
            args.append(max_rowid)
        rows = self.db.execute("SELECT r.rowid AS _rowid, r.* FROM record_versions r JOIN "
            "(SELECT record_id,MAX(version) v FROM record_versions WHERE scope=?" + filters +
            " GROUP BY record_id) c ON r.record_id=c.record_id AND r.version=c.v ORDER BY r.record_id", args)
        result=[]
        terms=query.casefold().split()
        source_cache = {}
        def verified_source(ref, source_scope):
            # Validate every examined record; reopen each exact revision once per search.
            if not isinstance(ref, dict) or not isinstance(ref.get("id"), str) or not isinstance(ref.get("revision"), str):
                return self._source(ref, source_scope)
            key = (source_scope, ref["id"], ref["revision"])
            if key not in source_cache:
                source_cache[key] = self._source(ref, source_scope)
            return source_cache[key]
        for row in rows:
            record=self._envelope(row, source_lookup=verified_source)
            searchable=(record["payload"]["text"]+" "+record["payload"]["type"]).casefold()
            if all(term in searchable for term in terms):
                result.append(record)
                if len(result)>=limit: break
        return result
    def context(self, query, scope, *, as_of=None, limit=20):
        records=self.search(query,scope,as_of=as_of,limit=limit)
        return {"schema_version":"noetis.knowledge-context.v1","scope":scope,"query":query,"as_of":as_of,"records":records,
                "status":"records_found" if records else "no_precedent_found",
                "authority":"source_backed_annotations; proposals are not approved instructions",
                "temporal_scope":"recorded version history, not inferred real-world validity"}

