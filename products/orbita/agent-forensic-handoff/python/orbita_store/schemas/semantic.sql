CREATE TABLE IF NOT EXISTS afh_generation_fences(id TEXT PRIMARY KEY,fence INTEGER NOT NULL);

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

CREATE INDEX IF NOT EXISTS records_scope_time ON record_versions(scope,recorded_at,record_id,version);

CREATE TABLE IF NOT EXISTS record_integrity_policy (
                        singleton INTEGER PRIMARY KEY CHECK(singleton=1), legacy_max_rowid INTEGER NOT NULL);

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

CREATE TABLE IF NOT EXISTS afh_publication_jobs (
        outbox_id TEXT PRIMARY KEY,state TEXT,owner TEXT,fence INTEGER NOT NULL DEFAULT 0,lease REAL NOT NULL DEFAULT 0,error TEXT);

CREATE TABLE IF NOT EXISTS afh_publication_events(seq INTEGER PRIMARY KEY,outbox_id TEXT,at REAL,state TEXT,detail TEXT);

CREATE TABLE IF NOT EXISTS afh_publications(outbox_id TEXT PRIMARY KEY,record_id TEXT,version INTEGER,payload_hash TEXT,text TEXT);

CREATE VIRTUAL TABLE IF NOT EXISTS afh_publication_fts USING fts5(outbox_id UNINDEXED,text);

CREATE TABLE IF NOT EXISTS afh_reevaluation_receipts(
      request_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, receipt TEXT NOT NULL, receipt_hash TEXT NOT NULL);

CREATE TRIGGER IF NOT EXISTS reevaluation_no_update BEFORE UPDATE ON afh_reevaluation_receipts BEGIN SELECT RAISE(ABORT,'append only'); END;

CREATE TRIGGER IF NOT EXISTS reevaluation_no_delete BEFORE DELETE ON afh_reevaluation_receipts BEGIN SELECT RAISE(ABORT,'append only'); END;

CREATE INDEX IF NOT EXISTS support_decision_lookup ON record_versions(scope,json_extract(payload,'$.support.kind'),json_extract(payload,'$.support.detail.decision.caseId'),json_extract(payload,'$.support.detail.alternativeId'),record_id,recorded_at);
