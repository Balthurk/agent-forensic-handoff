CREATE TABLE semantic_projection (
      id TEXT PRIMARY KEY, case_hash TEXT NOT NULL, source_snapshot_hash TEXT NOT NULL,
      projection_schema_version INTEGER NOT NULL, tool_version TEXT NOT NULL,
      provider_json TEXT NOT NULL, config_json TEXT NOT NULL, created_at TEXT NOT NULL,
      status TEXT NOT NULL, failure_reason TEXT, projection_hash TEXT NOT NULL,
      metrics_json TEXT NOT NULL DEFAULT '{}'
    );

CREATE TABLE semantic_embedding (
      rowid INTEGER PRIMARY KEY, content_hash TEXT NOT NULL UNIQUE, vector BLOB NOT NULL,
      vector_sha256 TEXT NOT NULL, dimensions INTEGER NOT NULL, created_at TEXT NOT NULL
    );

CREATE TABLE semantic_chunk (
      id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, embedding_rowid INTEGER NOT NULL REFERENCES semantic_embedding(rowid),
      event_id TEXT NOT NULL, source_id TEXT NOT NULL, record_ordinal INTEGER NOT NULL,
      evidence_uri TEXT NOT NULL, session_id TEXT NOT NULL, event_kind TEXT NOT NULL,
      event_status TEXT, actor_kind TEXT, observed_at TEXT, chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL, text_sha256 TEXT NOT NULL, redaction_state TEXT NOT NULL,
      created_at TEXT NOT NULL, start_cp INTEGER, end_cp INTEGER, token_count INTEGER, representation_id TEXT, source_text_sha256 TEXT
    );

CREATE VIRTUAL TABLE semantic_fts USING fts5(chunk_id UNINDEXED,text);

CREATE INDEX semantic_chunk_event_idx ON semantic_chunk(event_id,chunk_index);

CREATE INDEX semantic_chunk_embedding_idx ON semantic_chunk(embedding_rowid);

CREATE INDEX semantic_chunk_filter_idx ON semantic_chunk(session_id,event_kind,event_status,actor_kind,observed_at);

CREATE TABLE vector_index(rowid INTEGER PRIMARY KEY,embedding BLOB NOT NULL);
