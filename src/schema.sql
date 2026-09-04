PRAGMA foreign_keys = ON;
PRAGMA journal_mode = DELETE;

CREATE TABLE IF NOT EXISTS ingest_run (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  tool_version TEXT NOT NULL,
  config_json TEXT NOT NULL,
  source_snapshot_hash TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  record_count INTEGER NOT NULL DEFAULT 0,
  parsed_count INTEGER NOT NULL DEFAULT 0,
  unparsed_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS source (
  id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  native_uri TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  canonical_sha256 TEXT,
  byte_length INTEGER NOT NULL,
  canonical_byte_length INTEGER,
  compression TEXT NOT NULL,
  schema_hint TEXT,
  availability TEXT NOT NULL,
  evidence_path TEXT,
  UNIQUE(native_uri, raw_sha256)
);

CREATE TABLE IF NOT EXISTS source_record (
  source_id TEXT NOT NULL REFERENCES source(id),
  ordinal INTEGER NOT NULL,
  byte_offset INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  record_type TEXT,
  parse_status TEXT NOT NULL,
  parse_error TEXT,
  PRIMARY KEY(source_id, ordinal)
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  native_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  source_id TEXT,
  parent_native_id TEXT,
  cwd TEXT,
  started_at TEXT,
  ended_at TEXT,
  title TEXT,
  harness_version TEXT,
  model TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS session_edge (
  parent_session_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  grade TEXT NOT NULL DEFAULT 'EXPLICIT',
  rule_id TEXT,
  epistemic_status TEXT NOT NULL,
  evidence_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(parent_session_id, child_session_id, edge_type)
);

CREATE TABLE IF NOT EXISTS actor (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  native_id TEXT,
  role TEXT,
  display_name TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  epistemic_status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  source_id TEXT NOT NULL REFERENCES source(id),
  record_ordinal INTEGER NOT NULL,
  subordinal INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT,
  time_precision TEXT NOT NULL,
  actor_id TEXT REFERENCES actor(id),
  kind TEXT NOT NULL,
  subtype TEXT,
  phase TEXT,
  status TEXT,
  native_id TEXT,
  call_id TEXT,
  turn_id TEXT,
  parent_event_id TEXT,
  canonical INTEGER NOT NULL DEFAULT 1,
  duplicate_of TEXT,
  input_preview TEXT,
  output_preview TEXT,
  input_blob_sha256 TEXT,
  output_blob_sha256 TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  epistemic_status TEXT NOT NULL,
  FOREIGN KEY(source_id, record_ordinal) REFERENCES source_record(source_id, ordinal)
);

CREATE INDEX IF NOT EXISTS event_time_idx ON event(observed_at, source_id, record_ordinal, subordinal);
CREATE INDEX IF NOT EXISTS event_kind_idx ON event(kind, subtype);
CREATE INDEX IF NOT EXISTS event_call_idx ON event(call_id);
CREATE INDEX IF NOT EXISTS event_session_idx ON event(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(
  event_id UNINDEXED,
  kind,
  input_preview,
  output_preview,
  tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS event_edge (
  from_event_id TEXT NOT NULL REFERENCES event(id),
  to_event_id TEXT NOT NULL REFERENCES event(id),
  edge_type TEXT NOT NULL,
  grade TEXT NOT NULL,
  rule_id TEXT,
  epistemic_status TEXT NOT NULL,
  evidence_event_id TEXT REFERENCES event(id),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(from_event_id, to_event_id, edge_type)
);

CREATE TABLE IF NOT EXISTS entity_edge (
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  from_node_kind TEXT NOT NULL,
  to_node_kind TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  grade TEXT NOT NULL,
  rule_id TEXT NOT NULL DEFAULT '',
  epistemic_status TEXT NOT NULL,
  evidence_event_id TEXT REFERENCES event(id),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(from_node_id, to_node_id, edge_type, rule_id)
);

CREATE INDEX IF NOT EXISTS entity_edge_from_idx ON entity_edge(from_node_id,edge_type);
CREATE INDEX IF NOT EXISTS entity_edge_to_idx ON entity_edge(to_node_id,edge_type);

CREATE TABLE IF NOT EXISTS evidence_ref (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES event(id),
  source_id TEXT NOT NULL REFERENCES source(id),
  record_ordinal INTEGER NOT NULL,
  json_pointer TEXT NOT NULL DEFAULT '',
  byte_offset INTEGER,
  byte_length INTEGER,
  record_sha256 TEXT NOT NULL,
  uri TEXT NOT NULL,
  availability TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS evidence_event_idx ON evidence_ref(event_id);
CREATE INDEX IF NOT EXISTS evidence_source_record_idx ON evidence_ref(source_id,record_ordinal);

CREATE TABLE IF NOT EXISTS tool_execution (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  actor_id TEXT,
  tool_name TEXT NOT NULL,
  command_text TEXT,
  working_directory TEXT,
  call_event_id TEXT,
  result_event_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  status TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  input_blob_sha256 TEXT,
  output_blob_sha256 TEXT,
  semantic_extract TEXT,
  invocation_fingerprint TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tool_fingerprint_idx ON tool_execution(invocation_fingerprint);

CREATE TABLE IF NOT EXISTS artifact (
  id TEXT PRIMARY KEY,
  logical_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  workspace_root TEXT,
  current_path TEXT,
  current_status TEXT NOT NULL,
  current_sha256 TEXT,
  first_seen_at TEXT,
  last_seen_at TEXT,
  UNIQUE(logical_path, workspace_root)
);

CREATE TABLE IF NOT EXISTS artifact_revision (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifact(id),
  producer_event_id TEXT NOT NULL REFERENCES event(id),
  predecessor_revision_id TEXT,
  operation TEXT NOT NULL,
  content_sha256 TEXT,
  diff_blob_sha256 TEXT,
  observed_at TEXT,
  status TEXT NOT NULL,
  evidence_ref_id TEXT
);

CREATE INDEX IF NOT EXISTS artifact_revision_artifact_idx ON artifact_revision(artifact_id,observed_at,id);

CREATE TABLE IF NOT EXISTS claim (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_json TEXT NOT NULL,
  epistemic_status TEXT NOT NULL,
  derivation_rule TEXT,
  contradiction_set TEXT,
  source_event_id TEXT,
  evidence_refs_json TEXT NOT NULL,
  current INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS claim_predicate_idx ON claim(predicate,epistemic_status);

CREATE TABLE IF NOT EXISTS decision_record (
  id TEXT PRIMARY KEY,
  problem TEXT,
  alternatives_json TEXT NOT NULL DEFAULT '[]',
  decision_text TEXT NOT NULL,
  rationale TEXT,
  consequences_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  epistemic_status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  state TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  requested_event_id TEXT,
  last_event_id TEXT,
  verification_id TEXT,
  epistemic_status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS validation (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  level TEXT NOT NULL,
  method TEXT NOT NULL,
  command_text TEXT,
  observed_result TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  freshness_sha256 TEXT,
  status TEXT NOT NULL,
  evidence_event_id TEXT
);

CREATE TABLE IF NOT EXISTS state_snapshot (
  id TEXT PRIMARY KEY,
  workspace_root TEXT,
  observed_at TEXT NOT NULL,
  git_head TEXT,
  git_branch TEXT,
  git_status TEXT,
  metadata_json TEXT NOT NULL,
  sha256 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secret_finding (
  id TEXT PRIMARY KEY,
  source_id TEXT,
  event_id TEXT,
  kind TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  projection TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_blob (
  sha256 TEXT PRIMARY KEY,
  byte_length INTEGER NOT NULL,
  extension TEXT NOT NULL,
  storage TEXT NOT NULL CHECK(storage IN ('SQLITE','FILE')),
  inline_data BLOB,
  evidence_path TEXT,
  CHECK((storage='SQLITE' AND inline_data IS NOT NULL AND evidence_path IS NULL)
     OR (storage='FILE' AND inline_data IS NULL AND evidence_path IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS hydration_pack (
  id TEXT PRIMARY KEY,
  case_hash TEXT NOT NULL,
  token_budget INTEGER NOT NULL,
  token_estimate INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  generator_version TEXT NOT NULL,
  included_event_ids_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parse_warning (
  id TEXT PRIMARY KEY,
  source_id TEXT,
  record_ordinal INTEGER,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  evidence_ref_id TEXT
);
