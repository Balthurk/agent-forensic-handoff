CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT UNIQUE,salt TEXT,password TEXT,enabled INTEGER,admin INTEGER,epoch INTEGER);

CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user TEXT,epoch INTEGER,expires INTEGER,last_seen INTEGER,kind TEXT,workspace TEXT);

CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,revision INTEGER,payload TEXT);

CREATE TABLE IF NOT EXISTS members(workspace TEXT,user TEXT,role TEXT,revision INTEGER,PRIMARY KEY(workspace,user));

CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY,at TEXT,actor TEXT,action TEXT,workspace TEXT,detail TEXT);

CREATE TABLE IF NOT EXISTS attempts(name TEXT PRIMARY KEY,count INTEGER,until_at INTEGER);

CREATE TABLE IF NOT EXISTS archives(id TEXT PRIMARY KEY,workspace TEXT,payload TEXT);

CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,workspace TEXT,payload TEXT);
