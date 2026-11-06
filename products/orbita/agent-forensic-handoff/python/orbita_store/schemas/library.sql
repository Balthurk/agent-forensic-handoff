CREATE TABLE IF NOT EXISTS corpus_plans(id TEXT PRIMARY KEY,created_at TEXT,spec TEXT,cut TEXT,inventory TEXT,owner TEXT,pid INTEGER);

CREATE TABLE IF NOT EXISTS corpus_targets(id TEXT PRIMARY KEY,request TEXT,status TEXT,result TEXT,error TEXT,owner TEXT,pid INTEGER);

CREATE TABLE IF NOT EXISTS corpus_members(plan TEXT,target TEXT,ordinal INTEGER,case_id TEXT,event_id TEXT,source_role TEXT,PRIMARY KEY(plan,target));

CREATE INDEX IF NOT EXISTS corpus_member_page ON corpus_members(plan,ordinal);

CREATE INDEX IF NOT EXISTS corpus_target_pending ON corpus_targets(status);

CREATE TABLE IF NOT EXISTS corpus_events(seq INTEGER PRIMARY KEY,plan TEXT,target TEXT,at TEXT,status TEXT,detail TEXT);
