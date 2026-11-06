CREATE TABLE IF NOT EXISTS objects(generation TEXT,kind TEXT,key TEXT,payload TEXT,PRIMARY KEY(generation,kind,key));

CREATE TABLE IF NOT EXISTS markers(generation TEXT PRIMARY KEY,plan_hash TEXT,readback_hash TEXT);

CREATE TABLE IF NOT EXISTS selectors(scope TEXT,source_cut TEXT,generation TEXT,fence INTEGER,PRIMARY KEY(scope,source_cut));
