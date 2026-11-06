CREATE TABLE IF NOT EXISTS objects(uid TEXT PRIMARY KEY,group_id TEXT NOT NULL,kind TEXT NOT NULL,key TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(group_id,kind,key));
CREATE INDEX IF NOT EXISTS mirror_group_uid ON objects(group_id,uid);
CREATE TABLE IF NOT EXISTS links(owner_uid TEXT NOT NULL,label TEXT NOT NULL CHECK(label IN ('orbita_from','orbita_to')),target_uid TEXT NOT NULL,PRIMARY KEY(owner_uid,label),FOREIGN KEY(owner_uid) REFERENCES objects(uid),FOREIGN KEY(target_uid) REFERENCES objects(uid));
CREATE INDEX IF NOT EXISTS mirror_incoming ON links(target_uid,owner_uid,label);
