-- Installed by the separate local operator role, never by orbita_runtime.
-- All persistent state belongs to this database. Cases share family tables.
CREATE SCHEMA IF NOT EXISTS orbita_private;
CREATE SCHEMA IF NOT EXISTS orbita_common;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA orbita_private FROM PUBLIC;
REVOKE ALL ON SCHEMA orbita_common FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA orbita_private;

CREATE TABLE IF NOT EXISTS orbita_common.identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  instance_id uuid NOT NULL UNIQUE,
  version integer NOT NULL CHECK (version = 1)
);
CREATE TABLE IF NOT EXISTS orbita_private.workspaces (
  id uuid PRIMARY KEY,
  label text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('personal','managed','control','test')),
  parent_id uuid REFERENCES orbita_private.workspaces(id),
  capability_hash bytea NOT NULL,
  capability_secret text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS orbita_private.families (
  name text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9_]{0,39}$')
);
INSERT INTO orbita_private.families(name) VALUES
 ('case'),('semantic'),('corpus'),('access'),('capture'),('documents'),
 ('embedding'),('federation'),('generation'),('graph'),('graph_ledger'),('graph_mirror'),
 ('pipeline'),('reevaluation'),('turns'),('volume'),('vector'),('lease'),('library')
 ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS orbita_private.stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES orbita_private.workspaces(id),
  logical_key text NOT NULL,
  family text NOT NULL REFERENCES orbita_private.families(name),
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id, logical_key),
  UNIQUE(workspace_id, id)
);
CREATE TABLE IF NOT EXISTS orbita_private.sessions (
  pid integer NOT NULL,
  backend_start timestamptz NOT NULL,
  workspace_id uuid NOT NULL REFERENCES orbita_private.workspaces(id),
  store_id uuid,
  read_only boolean NOT NULL DEFAULT false,
  insert_serial bigint NOT NULL DEFAULT 0,
  last_insert_rowid bigint,
  PRIMARY KEY(pid, backend_start),
  FOREIGN KEY(workspace_id,store_id) REFERENCES orbita_private.stores(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS orbita_private.row_counters (
  store_id uuid NOT NULL REFERENCES orbita_private.stores(id),
  relation_name text NOT NULL,
  value bigint NOT NULL,
  PRIMARY KEY(store_id,relation_name)
);
CREATE TABLE IF NOT EXISTS orbita_private.schema_catalog (
  family text NOT NULL REFERENCES orbita_private.families(name),
  name text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('table','index','trigger')),
  source_sql text NOT NULL,
  source_hash text NOT NULL,
  definition jsonb NOT NULL,
  PRIMARY KEY(family,name)
);
CREATE TABLE IF NOT EXISTS orbita_private.store_catalog (
  store_id uuid NOT NULL REFERENCES orbita_private.stores(id),
  name text NOT NULL,
  kind text NOT NULL,
  source_sql text NOT NULL,
  PRIMARY KEY(store_id,name)
);

CREATE OR REPLACE FUNCTION orbita_common.workspace_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT s.workspace_id FROM orbita_private.sessions s
  JOIN orbita_private.workspaces w ON w.id=s.workspace_id
  WHERE s.pid=pg_backend_pid() AND w.active
    AND s.backend_start=(SELECT backend_start FROM pg_catalog.pg_stat_get_activity(pg_backend_pid()))
$$;
CREATE OR REPLACE FUNCTION orbita_common.store_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT s.store_id FROM orbita_private.sessions s
  JOIN orbita_private.workspaces w ON w.id=s.workspace_id
  WHERE s.pid=pg_backend_pid() AND w.active
    AND s.backend_start=(SELECT backend_start FROM pg_catalog.pg_stat_get_activity(pg_backend_pid()))
$$;
CREATE OR REPLACE FUNCTION orbita_common.can_write() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT COALESCE((SELECT NOT s.read_only FROM orbita_private.sessions s
    JOIN orbita_private.workspaces w ON w.id=s.workspace_id
    WHERE s.pid=pg_backend_pid() AND w.active
      AND s.backend_start=(SELECT backend_start FROM pg_catalog.pg_stat_get_activity(pg_backend_pid()))),false)
$$;
CREATE OR REPLACE FUNCTION orbita_common.authorize_workspace(wanted uuid, capability text, readonly boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE started timestamptz;
BEGIN
  IF session_user <> 'orbita_runtime' OR length(capability) NOT BETWEEN 32 AND 256
    OR NOT EXISTS(SELECT 1 FROM orbita_private.workspaces WHERE id=wanted AND active
      AND capability_hash=sha256(convert_to(capability,'UTF8')))
    THEN RAISE EXCEPTION 'ORBITA_PG_ACCESS_DENIED' USING ERRCODE='28000'; END IF;
  SELECT backend_start INTO STRICT started FROM pg_catalog.pg_stat_get_activity(pg_backend_pid());
  -- An activity snapshot can predate a newly admitted backend. Never prune
  -- another PID from that snapshot; only our own reused identity is safe.
  DELETE FROM orbita_private.sessions
    WHERE pid=pg_backend_pid() AND backend_start<>started;
  INSERT INTO orbita_private.sessions(pid,backend_start,workspace_id,store_id,read_only)
    VALUES(pg_backend_pid(),started,wanted,NULL,readonly)
    ON CONFLICT(pid,backend_start) DO UPDATE SET workspace_id=excluded.workspace_id,store_id=NULL,read_only=readonly;
END $$;
CREATE OR REPLACE FUNCTION orbita_common.deauthorize() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  DELETE FROM orbita_private.sessions WHERE pid=pg_backend_pid()
    AND backend_start=(SELECT backend_start FROM pg_catalog.pg_stat_get_activity(pg_backend_pid()))
$$;
CREATE OR REPLACE FUNCTION orbita_common.open_store(wanted_key text,wanted_family text,create_missing boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE workspace uuid; found uuid; existing_family text;
BEGIN
  workspace=orbita_common.workspace_id();
  IF workspace IS NULL THEN RAISE EXCEPTION 'ORBITA_PG_ACCESS_DENIED' USING ERRCODE='28000'; END IF;
  IF wanted_key IS NULL OR length(wanted_key) NOT BETWEEN 1 AND 4096
    OR wanted_key ~ '(^/|(^|/)\.\.(/|$)|\\|:|[[:cntrl:]])'
    OR NOT EXISTS(SELECT 1 FROM orbita_private.families WHERE name=wanted_family)
    THEN RAISE EXCEPTION 'ORBITA_PG_INVALID_STORE_KEY' USING ERRCODE='22023'; END IF;
  IF create_missing THEN
    IF NOT orbita_common.can_write() THEN RAISE EXCEPTION 'ORBITA_PG_READ_ONLY' USING ERRCODE='25006'; END IF;
    INSERT INTO orbita_private.stores(workspace_id,logical_key,family)
      VALUES(workspace,wanted_key,wanted_family) ON CONFLICT(workspace_id,logical_key) DO NOTHING;
  END IF;
  SELECT id,family INTO found,existing_family FROM orbita_private.stores
    WHERE workspace_id=workspace AND logical_key=wanted_key;
  IF found IS NULL THEN RAISE EXCEPTION 'ORBITA_PG_STORE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF existing_family<>wanted_family THEN RAISE EXCEPTION 'ORBITA_PG_STORE_FAMILY_CHANGED' USING ERRCODE='22023'; END IF;
  UPDATE orbita_private.sessions SET store_id=found WHERE pid=pg_backend_pid()
    AND backend_start=(SELECT backend_start FROM pg_catalog.pg_stat_get_activity(pg_backend_pid()));
  RETURN found;
END $$;
CREATE OR REPLACE FUNCTION orbita_common.next_rowid(relation_name text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE store uuid; result bigint;
BEGIN
  store=orbita_common.store_id();
  IF store IS NULL THEN RAISE EXCEPTION 'ORBITA_PG_STORE_NOT_BOUND' USING ERRCODE='28000'; END IF;
  IF NOT orbita_common.can_write() THEN RAISE EXCEPTION 'ORBITA_PG_READ_ONLY' USING ERRCODE='25006'; END IF;
  INSERT INTO orbita_private.row_counters(store_id,relation_name,value) VALUES(store,relation_name,1)
    ON CONFLICT ON CONSTRAINT row_counters_pkey DO UPDATE SET value=orbita_private.row_counters.value+1
    RETURNING value INTO result;
  RETURN result;
END $$;
CREATE OR REPLACE FUNCTION orbita_common.catalogue(wanted_family text) RETURNS TABLE
 (name text,kind text,source_sql text,source_hash text,definition jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT name,kind,source_sql,source_hash,definition FROM orbita_private.schema_catalog
    WHERE family=wanted_family AND orbita_common.workspace_id() IS NOT NULL
$$;
CREATE OR REPLACE FUNCTION orbita_common.ensure_definition(wanted_name text,wanted_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE store uuid; wanted_family text; item orbita_private.schema_catalog%ROWTYPE;
BEGIN
  store=orbita_common.store_id();
  IF store IS NULL THEN RAISE EXCEPTION 'ORBITA_PG_STORE_NOT_BOUND' USING ERRCODE='28000'; END IF;
  IF NOT orbita_common.can_write() THEN RAISE EXCEPTION 'ORBITA_PG_READ_ONLY' USING ERRCODE='25006'; END IF;
  SELECT family INTO STRICT wanted_family FROM orbita_private.stores WHERE id=store;
  SELECT * INTO item FROM orbita_private.schema_catalog WHERE family=wanted_family AND name=wanted_name;
  IF item.name IS NULL OR item.source_hash<>wanted_hash
    THEN RAISE EXCEPTION 'ORBITA_PG_UNKNOWN_DEFINITION' USING ERRCODE='22023'; END IF;
  INSERT INTO orbita_private.store_catalog(store_id,name,kind,source_sql)
    VALUES(store,item.name,item.kind,item.source_sql) ON CONFLICT DO NOTHING;
  RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION orbita_common.logical_catalogue() RETURNS TABLE(name text,type text,sql text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT name,kind,source_sql FROM orbita_private.store_catalog WHERE store_id=orbita_common.store_id()
$$;

-- File content and locator metadata live in the same database. A reader pins an
-- immutable object id; publishing/replacing a name cannot change those bytes.
CREATE TABLE IF NOT EXISTS orbita_common.objects (
  workspace_id uuid NOT NULL DEFAULT orbita_common.workspace_id(),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  size bigint NOT NULL DEFAULT 0 CHECK(size>=0),
  sha256 text,
  complete boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id) REFERENCES orbita_private.workspaces(id)
);
CREATE TABLE IF NOT EXISTS orbita_common.chunk_blobs (
  workspace_id uuid NOT NULL DEFAULT orbita_common.workspace_id(),
  bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 1048576),
  sha256 text GENERATED ALWAYS AS (encode(sha256(bytes),'hex')) STORED,
  PRIMARY KEY(workspace_id,sha256),
  FOREIGN KEY(workspace_id) REFERENCES orbita_private.workspaces(id)
);
CREATE TABLE IF NOT EXISTS orbita_common.object_chunks (
  workspace_id uuid NOT NULL DEFAULT orbita_common.workspace_id(),
  object_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal>=0),
  chunk_hash text NOT NULL,
  PRIMARY KEY(workspace_id,object_id,ordinal),
  FOREIGN KEY(workspace_id,object_id) REFERENCES orbita_common.objects(workspace_id,id),
  FOREIGN KEY(workspace_id,chunk_hash) REFERENCES orbita_common.chunk_blobs(workspace_id,sha256)
);
CREATE TABLE IF NOT EXISTS orbita_common.entries (
  workspace_id uuid NOT NULL DEFAULT orbita_common.workspace_id(),
  path text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('file','directory','store')),
  object_id uuid,
  store_id uuid,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  modified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,path),
  FOREIGN KEY(workspace_id,object_id) REFERENCES orbita_common.objects(workspace_id,id),
  FOREIGN KEY(workspace_id,store_id) REFERENCES orbita_private.stores(workspace_id,id),
  CHECK((kind='file' AND object_id IS NOT NULL AND store_id IS NULL)
    OR (kind='directory' AND object_id IS NULL AND store_id IS NULL)
    OR (kind='store' AND object_id IS NULL AND store_id IS NOT NULL)),
  CHECK(path !~ '(^/|(^|/)\.\.(/|$)|\\|:|[[:cntrl:]])')
);
ALTER TABLE orbita_common.objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE orbita_common.objects FORCE ROW LEVEL SECURITY;
ALTER TABLE orbita_common.object_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE orbita_common.object_chunks FORCE ROW LEVEL SECURITY;
ALTER TABLE orbita_common.entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE orbita_common.entries FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_objects_read ON orbita_common.objects FOR SELECT
  USING(workspace_id=(SELECT orbita_common.workspace_id()));
CREATE POLICY workspace_objects_write ON orbita_common.objects FOR ALL
  USING(workspace_id=(SELECT orbita_common.workspace_id()) AND (SELECT orbita_common.can_write()))
  WITH CHECK(workspace_id=(SELECT orbita_common.workspace_id()) AND (SELECT orbita_common.can_write()));
CREATE POLICY workspace_chunks_read ON orbita_common.object_chunks FOR SELECT
  USING(workspace_id=(SELECT orbita_common.workspace_id()));
CREATE POLICY workspace_chunks_write ON orbita_common.object_chunks FOR ALL
  USING(workspace_id=(SELECT orbita_common.workspace_id()) AND (SELECT orbita_common.can_write()))
  WITH CHECK(workspace_id=(SELECT orbita_common.workspace_id()) AND (SELECT orbita_common.can_write()));
CREATE POLICY workspace_entries_read ON orbita_common.entries FOR SELECT
  USING(workspace_id=(SELECT orbita_common.workspace_id()));
CREATE POLICY workspace_entries_write ON orbita_common.entries FOR ALL
  USING(workspace_id=(SELECT orbita_common.workspace_id()) AND (SELECT orbita_common.can_write()))
  WITH CHECK(workspace_id=(SELECT orbita_common.workspace_id()) AND (SELECT orbita_common.can_write()));

REVOKE ALL ON ALL TABLES IN SCHEMA orbita_private FROM PUBLIC,orbita_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA orbita_private FROM PUBLIC,orbita_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA orbita_common FROM PUBLIC;
GRANT USAGE ON SCHEMA orbita_common TO orbita_runtime;
GRANT SELECT ON orbita_common.identity TO orbita_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON orbita_common.objects,orbita_common.object_chunks,orbita_common.entries TO orbita_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA orbita_common TO orbita_runtime;
