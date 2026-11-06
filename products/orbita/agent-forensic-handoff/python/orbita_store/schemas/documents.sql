CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,case_id TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS document_versions(document_id TEXT,revision INTEGER,case_id TEXT UNIQUE,item TEXT,PRIMARY KEY(document_id,revision));

CREATE TABLE IF NOT EXISTS document_writers(id TEXT PRIMARY KEY,owner TEXT,pid INTEGER);
