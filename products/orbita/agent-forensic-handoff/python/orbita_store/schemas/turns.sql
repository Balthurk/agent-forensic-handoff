CREATE TABLE IF NOT EXISTS turns(conversation TEXT,ordinal INTEGER,turn_id TEXT UNIQUE,role TEXT,text TEXT,corrects TEXT,at TEXT,request TEXT UNIQUE,request_hash TEXT,PRIMARY KEY(conversation,ordinal));

CREATE TRIGGER IF NOT EXISTS turns_no_update BEFORE UPDATE ON turns BEGIN SELECT RAISE(ABORT,'append only'); END;

CREATE TRIGGER IF NOT EXISTS turns_no_delete BEFORE DELETE ON turns BEGIN SELECT RAISE(ABORT,'append only'); END;
