CREATE TABLE IF NOT EXISTS vectors(namespace TEXT,text_hash TEXT,text TEXT,vector TEXT,vector_hash TEXT,PRIMARY KEY(namespace,text_hash));

CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,started TEXT,ended TEXT,status TEXT,identity TEXT,metrics TEXT,error TEXT);
