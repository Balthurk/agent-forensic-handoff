CREATE TABLE IF NOT EXISTS pipelines(id TEXT PRIMARY KEY,spec TEXT,stage TEXT,owner TEXT,lease INTEGER DEFAULT 0,error TEXT);

CREATE TABLE IF NOT EXISTS targets(id TEXT PRIMARY KEY,request TEXT,status TEXT,result TEXT,error TEXT);

CREATE TABLE IF NOT EXISTS members(pipeline TEXT,target TEXT,case_id TEXT,source_id TEXT,PRIMARY KEY(pipeline,target));

CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,pipeline TEXT,at TEXT,stage TEXT,detail TEXT);
