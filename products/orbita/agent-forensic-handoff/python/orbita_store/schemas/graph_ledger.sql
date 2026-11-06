CREATE TABLE IF NOT EXISTS claims(config TEXT,scope TEXT,owner TEXT,fence INTEGER,expires REAL,PRIMARY KEY(config,scope));

CREATE TABLE IF NOT EXISTS receipts(config TEXT,generation TEXT,fence INTEGER,payload TEXT,sha TEXT,PRIMARY KEY(config,generation,fence));

CREATE TABLE IF NOT EXISTS selectors(config TEXT,scope TEXT,generation TEXT,fence INTEGER,sha TEXT,PRIMARY KEY(config,scope));
