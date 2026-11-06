CREATE TABLE IF NOT EXISTS source_bindings (
            id TEXT PRIMARY KEY, revision TEXT NOT NULL, metadata TEXT NOT NULL, digest TEXT NOT NULL, registered_at TEXT NOT NULL);

CREATE TRIGGER IF NOT EXISTS source_no_update BEFORE UPDATE ON source_bindings BEGIN SELECT RAISE(ABORT,'append only'); END;

CREATE TRIGGER IF NOT EXISTS source_no_delete BEFORE DELETE ON source_bindings BEGIN SELECT RAISE(ABORT,'append only'); END;
