-- Shared immutable bytes and version pins. The runtime cannot erase completed
-- bytes directly. GC is an explicit, scoped operation over supplied object IDs.
CREATE TABLE IF NOT EXISTS orbita_common.chunk_blobs (
  workspace_id uuid NOT NULL DEFAULT orbita_common.workspace_id(),
  bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 1048576),
  sha256 text GENERATED ALWAYS AS (encode(sha256(bytes),'hex')) STORED,
  PRIMARY KEY(workspace_id,sha256),
  FOREIGN KEY(workspace_id) REFERENCES orbita_private.workspaces(id)
);
-- Upgrade the unreleased PG01 foundation only if it contains no chunk data.
-- An existing data-bearing layout needs an explicit verified migration.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='orbita_common'
      AND table_name='object_chunks' AND column_name='bytes') THEN
    IF EXISTS(SELECT 1 FROM orbita_common.object_chunks) THEN
      RAISE EXCEPTION 'ORBITA_PG_CHUNK_MIGRATION_REQUIRES_RECEIPT'; END IF;
    ALTER TABLE orbita_common.object_chunks DROP COLUMN bytes;
    ALTER TABLE orbita_common.object_chunks ADD COLUMN chunk_hash text NOT NULL;
    ALTER TABLE orbita_common.object_chunks ADD FOREIGN KEY(workspace_id,chunk_hash)
      REFERENCES orbita_common.chunk_blobs(workspace_id,sha256);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS orbita_private.object_pins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pid integer NOT NULL,
  backend_start timestamptz NOT NULL,
  workspace_id uuid NOT NULL,
  object_id uuid NOT NULL,
  FOREIGN KEY(workspace_id,object_id) REFERENCES orbita_common.objects(workspace_id,id)
);
ALTER TABLE orbita_common.chunk_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE orbita_common.chunk_blobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS blobs_read ON orbita_common.chunk_blobs;
DROP POLICY IF EXISTS blobs_insert ON orbita_common.chunk_blobs;
CREATE POLICY blobs_read ON orbita_common.chunk_blobs FOR SELECT
  USING(workspace_id=(SELECT orbita_common.workspace_id()));
CREATE POLICY blobs_insert ON orbita_common.chunk_blobs FOR INSERT
  WITH CHECK(workspace_id=(SELECT orbita_common.workspace_id()) AND (SELECT orbita_common.can_write()));

CREATE OR REPLACE FUNCTION orbita_common.guard_object() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actual_size bigint; actual_count bigint; last_ordinal bigint;
BEGIN
  IF TG_OP='DELETE' THEN
    IF current_user='orbita_runtime' THEN RAISE EXCEPTION 'ORBITA_PG_EXPLICIT_GC_REQUIRED'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD.complete THEN
    RAISE EXCEPTION 'ORBITA_PG_OBJECT_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF NEW.complete THEN
    IF NEW.sha256 IS NULL OR NEW.sha256 !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'ORBITA_PG_OBJECT_HASH_REQUIRED' USING ERRCODE='23514'; END IF;
    SELECT COALESCE(sum(octet_length(b.bytes)),0),count(*),max(c.ordinal)
      INTO actual_size,actual_count,last_ordinal FROM orbita_common.object_chunks c
      JOIN orbita_common.chunk_blobs b ON b.workspace_id=c.workspace_id AND b.sha256=c.chunk_hash
      WHERE c.workspace_id=NEW.workspace_id AND c.object_id=NEW.id;
    IF actual_size<>NEW.size OR (actual_count>0 AND last_ordinal<>actual_count-1)
      OR EXISTS(SELECT 1 FROM orbita_common.object_chunks c
        JOIN orbita_common.chunk_blobs b ON b.workspace_id=c.workspace_id AND b.sha256=c.chunk_hash
        WHERE c.workspace_id=NEW.workspace_id AND c.object_id=NEW.id
          AND c.ordinal<last_ordinal AND octet_length(b.bytes)<>1048576) THEN
      RAISE EXCEPTION 'ORBITA_PG_OBJECT_INCOMPLETE' USING ERRCODE='23514'; END IF;
    IF NEW.size=0 AND NEW.sha256<>encode(sha256(''::bytea),'hex') THEN
      RAISE EXCEPTION 'ORBITA_PG_EMPTY_OBJECT_HASH' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION orbita_common.guard_chunk() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE owner_workspace uuid; owner_object uuid; completed boolean;
BEGIN
  owner_workspace=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
  owner_object=CASE WHEN TG_OP='DELETE' THEN OLD.object_id ELSE NEW.object_id END;
  SELECT complete INTO STRICT completed FROM orbita_common.objects
    WHERE workspace_id=owner_workspace AND id=owner_object FOR UPDATE;
  IF completed AND NOT (TG_OP='DELETE' AND current_user<>'orbita_runtime') THEN
    RAISE EXCEPTION 'ORBITA_PG_OBJECT_IMMUTABLE' USING ERRCODE='23514'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE OR REPLACE FUNCTION orbita_common.guard_entry() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.kind='file' AND NOT EXISTS(SELECT 1 FROM orbita_common.objects
      WHERE workspace_id=NEW.workspace_id AND id=NEW.object_id AND complete) THEN
    RAISE EXCEPTION 'ORBITA_PG_OBJECT_NOT_COMPLETE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS immutable_object ON orbita_common.objects;
CREATE TRIGGER immutable_object BEFORE INSERT OR UPDATE OR DELETE ON orbita_common.objects
  FOR EACH ROW EXECUTE FUNCTION orbita_common.guard_object();
DROP TRIGGER IF EXISTS immutable_chunk ON orbita_common.object_chunks;
CREATE TRIGGER immutable_chunk BEFORE INSERT OR UPDATE OR DELETE ON orbita_common.object_chunks
  FOR EACH ROW EXECUTE FUNCTION orbita_common.guard_chunk();
DROP TRIGGER IF EXISTS complete_entry ON orbita_common.entries;
CREATE TRIGGER complete_entry BEFORE INSERT OR UPDATE ON orbita_common.entries
  FOR EACH ROW EXECUTE FUNCTION orbita_common.guard_entry();

CREATE OR REPLACE FUNCTION orbita_common.pin_object(wanted uuid,allow_incomplete boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE workspace uuid; result uuid;
BEGIN
  workspace=orbita_common.workspace_id();
  PERFORM 1 FROM orbita_common.objects WHERE workspace_id=workspace AND id=wanted
    AND (complete OR allow_incomplete AND orbita_common.can_write()) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORBITA_PG_OBJECT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  INSERT INTO orbita_private.object_pins(pid,backend_start,workspace_id,object_id)
    SELECT pg_backend_pid(),backend_start,workspace,wanted FROM pg_catalog.pg_stat_activity
      WHERE pid=pg_backend_pid() RETURNING id INTO result;
  RETURN result;
END $$;
CREATE OR REPLACE FUNCTION orbita_common.unpin_object(wanted uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE workspace uuid; object uuid;
BEGIN
  DELETE FROM orbita_private.object_pins WHERE id=wanted AND pid=pg_backend_pid()
    AND backend_start=(SELECT backend_start FROM pg_catalog.pg_stat_get_activity(pg_backend_pid()))
    RETURNING workspace_id,object_id INTO workspace,object;
  IF FOUND THEN PERFORM orbita_private.collect_objects_in_workspace(workspace,ARRAY[object]); END IF;
END
$$;
CREATE OR REPLACE FUNCTION orbita_common.deauthorize() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE started timestamptz;
BEGIN
  SELECT backend_start INTO started FROM pg_catalog.pg_stat_get_activity(pg_backend_pid());
  DELETE FROM orbita_private.object_pins WHERE pid=pg_backend_pid() AND backend_start=started;
  DELETE FROM orbita_private.sessions WHERE pid=pg_backend_pid() AND backend_start=started;
END $$;
CREATE OR REPLACE FUNCTION orbita_private.collect_objects_in_workspace(workspace uuid,wanted uuid[]) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE candidate uuid; removed bigint=0; chunks text[];
BEGIN
  IF cardinality(wanted)>1000 THEN RAISE EXCEPTION 'ORBITA_PG_GC_BATCH_LIMIT'; END IF;
  -- The caller may have cached activity before a new reader connected.
  -- Refresh immediately before this single DELETE: its row snapshot is
  -- acquired before the first activity read, so later pins cannot be pruned.
  PERFORM pg_stat_clear_snapshot();
  DELETE FROM orbita_private.object_pins p WHERE p.workspace_id=workspace AND NOT EXISTS
    (SELECT 1 FROM pg_catalog.pg_stat_activity a WHERE a.pid=p.pid AND a.backend_start=p.backend_start);
  FOREACH candidate IN ARRAY wanted LOOP
    PERFORM 1 FROM orbita_common.objects WHERE workspace_id=workspace AND id=candidate FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF EXISTS(SELECT 1 FROM orbita_common.entries WHERE workspace_id=workspace AND object_id=candidate)
      OR EXISTS(SELECT 1 FROM orbita_private.object_pins WHERE workspace_id=workspace AND object_id=candidate)
      THEN CONTINUE; END IF;
    SELECT array_agg(chunk_hash) INTO chunks FROM orbita_common.object_chunks
      WHERE workspace_id=workspace AND object_id=candidate;
    DELETE FROM orbita_common.object_chunks WHERE workspace_id=workspace AND object_id=candidate;
    DELETE FROM orbita_common.objects WHERE workspace_id=workspace AND id=candidate;
    DELETE FROM orbita_common.chunk_blobs b WHERE b.workspace_id=workspace AND b.sha256=ANY(chunks)
      AND NOT EXISTS(SELECT 1 FROM orbita_common.object_chunks c WHERE c.workspace_id=workspace AND c.chunk_hash=b.sha256);
    removed=removed+1;
  END LOOP;
  RETURN removed;
END $$;
CREATE OR REPLACE FUNCTION orbita_common.collect_objects(wanted uuid[]) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE workspace uuid;
BEGIN
  workspace=orbita_common.workspace_id();
  IF workspace IS NULL OR NOT orbita_common.can_write() THEN
    RAISE EXCEPTION 'ORBITA_PG_ACCESS_DENIED' USING ERRCODE='28000'; END IF;
  RETURN orbita_private.collect_objects_in_workspace(workspace,wanted);
END $$;
CREATE OR REPLACE FUNCTION orbita_common.reclaim_candidates() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT o.id FROM orbita_common.objects o WHERE o.workspace_id=orbita_common.workspace_id()
    AND orbita_common.can_write()
    AND NOT EXISTS(SELECT 1 FROM orbita_common.entries e WHERE e.workspace_id=o.workspace_id AND e.object_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM orbita_private.object_pins p JOIN pg_catalog.pg_stat_activity a
      ON a.pid=p.pid AND a.backend_start=p.backend_start WHERE p.workspace_id=o.workspace_id AND p.object_id=o.id)
    ORDER BY o.created_at,o.id LIMIT 1000
$$;
-- A complete bounded payload needs no committed staging version or live pin.
-- The caller's RLS and the original integrity triggers apply to every command.
-- The namespace lock lasts through publication; a failed command rolls back
-- the entire new version. Retired-version GC remains a separate caller step.
CREATE OR REPLACE FUNCTION orbita_common.write_small_object(wanted_path text,payload bytea,wanted_exclusive boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE parent_path text; parent_kind text; prior orbita_common.entries%ROWTYPE;
  created uuid; digest text; published_revision bigint;
BEGIN
  IF wanted_path IS NULL OR length(wanted_path)>4096 OR wanted_path ~ '(^/|(^|/)\.\.(/|$)|\\|:|[[:cntrl:]])'
    OR payload IS NULL OR octet_length(payload)>1048576 OR wanted_exclusive IS NULL THEN
    RAISE EXCEPTION 'ORBITA_PG_SMALL_WRITE_ARGUMENT' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('names:' || orbita_common.workspace_id()::text,0));
  parent_path=CASE WHEN strpos(wanted_path,'/')=0 THEN ''
    ELSE left(wanted_path,length(wanted_path)-strpos(reverse(wanted_path),'/')) END;
  SELECT e.kind INTO parent_kind FROM orbita_common.entries e WHERE e.path=parent_path;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORBITA_PG_SMALL_WRITE_PARENT_MISSING' USING ERRCODE='P0002'; END IF;
  IF parent_kind<>'directory' THEN RAISE EXCEPTION 'ORBITA_PG_SMALL_WRITE_PARENT_NOT_DIRECTORY' USING ERRCODE='42809'; END IF;
  SELECT e.* INTO prior FROM orbita_common.entries e WHERE e.path=wanted_path FOR UPDATE;
  IF FOUND THEN
    IF prior.kind<>'file' THEN RAISE EXCEPTION 'ORBITA_PG_SMALL_WRITE_IS_DIRECTORY' USING ERRCODE='42809'; END IF;
    IF wanted_exclusive THEN RAISE EXCEPTION 'ORBITA_PG_SMALL_WRITE_EXISTS' USING ERRCODE='23505'; END IF;
  END IF;
  INSERT INTO orbita_common.objects DEFAULT VALUES RETURNING id INTO created;
  digest=encode(sha256(payload),'hex');
  IF octet_length(payload)>0 THEN
    INSERT INTO orbita_common.chunk_blobs(bytes) VALUES(payload) ON CONFLICT DO NOTHING;
    INSERT INTO orbita_common.object_chunks(object_id,ordinal,chunk_hash) VALUES(created,0,digest);
  END IF;
  UPDATE orbita_common.objects SET size=octet_length(payload),sha256=digest,complete=true WHERE id=created;
  INSERT INTO orbita_common.entries(path,kind,object_id) VALUES(wanted_path,'file',created)
    ON CONFLICT(workspace_id,path) DO UPDATE SET object_id=excluded.object_id,
      revision=orbita_common.entries.revision+1,modified_at=clock_timestamp()
    RETURNING revision INTO published_revision;
  RETURN jsonb_build_object('objectId',created,'size',octet_length(payload),'sha256',digest,
    'revision',published_revision,'retiredObjectId',prior.object_id);
END $$;
REVOKE ALL ON FUNCTION orbita_common.write_small_object(text,bytea,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orbita_common.write_small_object(text,bytea,boolean) TO orbita_runtime;

REVOKE ALL ON orbita_private.object_pins FROM PUBLIC,orbita_runtime;
REVOKE ALL ON FUNCTION orbita_private.collect_objects_in_workspace(uuid,uuid[]) FROM PUBLIC,orbita_runtime;
REVOKE ALL ON orbita_common.chunk_blobs FROM PUBLIC,orbita_runtime;
GRANT SELECT,INSERT ON orbita_common.chunk_blobs TO orbita_runtime;
REVOKE UPDATE,DELETE ON orbita_common.object_chunks FROM orbita_runtime;
REVOKE DELETE ON orbita_common.objects FROM orbita_runtime;
REVOKE ALL ON FUNCTION orbita_common.guard_object(),orbita_common.guard_chunk(),orbita_common.guard_entry(),
  orbita_common.pin_object(uuid,boolean),orbita_common.unpin_object(uuid),orbita_common.collect_objects(uuid[]),orbita_common.reclaim_candidates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orbita_common.pin_object(uuid,boolean),orbita_common.unpin_object(uuid),
  orbita_common.collect_objects(uuid[]),orbita_common.reclaim_candidates() TO orbita_runtime;

-- Directory creation retains the namespace transaction in one server call.
-- Invoker rights, fresh RLS and the same namespace lock govern every command.
CREATE OR REPLACE FUNCTION orbita_common.make_directory(wanted_path text,wanted_parents boolean,wanted_exist_ok boolean)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE prior_kind text;parent_path text;parent_kind text;parts text[];i integer;
BEGIN
  IF wanted_path IS NULL OR length(wanted_path)>4096 OR wanted_path ~ '(^/|(^|/)\.\.(/|$)|\\|:|[[:cntrl:]])'
    OR wanted_parents IS NULL OR wanted_exist_ok IS NULL THEN
    RAISE EXCEPTION 'ORBITA_PG_MKDIR_ARGUMENT' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('names:' || orbita_common.workspace_id()::text,0));
  SELECT e.kind INTO prior_kind FROM orbita_common.entries e WHERE e.path=wanted_path;
  IF FOUND THEN
    IF wanted_exist_ok AND prior_kind='directory' THEN RETURN; END IF;
    RAISE EXCEPTION 'ORBITA_PG_MKDIR_EXISTS' USING ERRCODE='23505',DETAIL=wanted_path;
  END IF;
  IF wanted_path<>'' AND wanted_parents THEN
    parts=string_to_array(wanted_path,'/');
    FOR i IN 0..array_length(parts,1)-1 LOOP
      parent_path=CASE WHEN i=0 THEN '' ELSE array_to_string(parts[1:i],'/') END;
      SELECT e.kind INTO parent_kind FROM orbita_common.entries e WHERE e.path=parent_path;
      IF NOT FOUND THEN INSERT INTO orbita_common.entries(path,kind) VALUES(parent_path,'directory');
      ELSIF parent_kind<>'directory' THEN
        RAISE EXCEPTION 'ORBITA_PG_MKDIR_PARENT_NOT_DIRECTORY' USING ERRCODE='42809',DETAIL=parent_path;
      END IF;
    END LOOP;
  ELSIF wanted_path<>'' THEN
    parent_path=CASE WHEN strpos(wanted_path,'/')=0 THEN '' ELSE left(wanted_path,length(wanted_path)-strpos(reverse(wanted_path),'/')) END;
    SELECT e.kind INTO parent_kind FROM orbita_common.entries e WHERE e.path=parent_path;
    IF NOT FOUND THEN RAISE EXCEPTION 'ORBITA_PG_MKDIR_PARENT_MISSING' USING ERRCODE='P0002',DETAIL=parent_path; END IF;
    IF parent_kind<>'directory' THEN RAISE EXCEPTION 'ORBITA_PG_MKDIR_PARENT_NOT_DIRECTORY' USING ERRCODE='42809',DETAIL=parent_path; END IF;
  END IF;
  INSERT INTO orbita_common.entries(path,kind) VALUES(wanted_path,'directory');
END $$;
REVOKE ALL ON FUNCTION orbita_common.make_directory(text,boolean,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orbita_common.make_directory(text,boolean,boolean) TO orbita_runtime;
