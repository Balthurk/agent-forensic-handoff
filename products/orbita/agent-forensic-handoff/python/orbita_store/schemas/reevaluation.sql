CREATE TABLE IF NOT EXISTS watches(id TEXT PRIMARY KEY,config TEXT NOT NULL,hash TEXT NOT NULL,created_at TEXT NOT NULL,owner TEXT,fence INTEGER NOT NULL DEFAULT 0,lease INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS seen(watch_id TEXT,source_key TEXT,PRIMARY KEY(watch_id,source_key));

CREATE TABLE IF NOT EXISTS scanned(watch_id TEXT,case_id TEXT,PRIMARY KEY(watch_id,case_id));

CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,watch_id TEXT,request TEXT NOT NULL,hash TEXT NOT NULL,status TEXT NOT NULL,error TEXT,run_request TEXT,result TEXT,created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,at TEXT,kind TEXT,detail TEXT);
