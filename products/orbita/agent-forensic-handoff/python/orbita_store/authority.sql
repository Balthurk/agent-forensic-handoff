-- Private, non-MVCC revocation fences. Content still uses ordinary coherent
-- MVCC snapshots, including REPEATABLE READ / SERIALIZABLE READ ONLY.
-- Sequences are control metadata per workspace, never tables/schemas per case.
ALTER TABLE orbita_private.sessions ADD COLUMN IF NOT EXISTS authority_fence bigint;
ALTER TABLE orbita_private.sessions ADD COLUMN IF NOT EXISTS worker_fence bigint;
ALTER TABLE orbita_private.sessions ADD COLUMN IF NOT EXISTS parent_fence bigint;
ALTER TABLE orbita_private.sessions ADD COLUMN IF NOT EXISTS maintenance boolean NOT NULL DEFAULT false;
ALTER TABLE orbita_private.sessions ADD COLUMN IF NOT EXISTS worker_epoch bigint;

-- Transactional insertion receipts are separate from authorization identity.
-- An append permits indexed latest-row lookup without rewriting the identity
-- or one status tuple for every row of a long, savepoint-protected transaction.
CREATE TABLE IF NOT EXISTS orbita_private.insert_events (
  pid integer NOT NULL,
  backend_start timestamptz NOT NULL,
  serial bigint NOT NULL CHECK(serial>0),
  last_insert_rowid bigint NOT NULL,
  PRIMARY KEY(pid,backend_start,serial),
  FOREIGN KEY(pid,backend_start) REFERENCES orbita_private.sessions(pid,backend_start) ON DELETE CASCADE
);
REVOKE ALL ON orbita_private.insert_events FROM PUBLIC,orbita_runtime;
-- Preserve the last committed legacy status on upgrade. Reinstalling must not
-- overwrite newer receipts; the legacy columns remain for migration only.
INSERT INTO orbita_private.insert_events(pid,backend_start,serial,last_insert_rowid)
  SELECT pid,backend_start,insert_serial,last_insert_rowid FROM orbita_private.sessions
  WHERE insert_serial>0 AND last_insert_rowid IS NOT NULL ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION orbita_private.authority_name(wanted uuid,worker boolean)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT (CASE WHEN worker THEN 'authw_' ELSE 'authg_' END)||replace(wanted::text,'-','')
$$;
CREATE OR REPLACE FUNCTION orbita_private.prepare_authority(wanted uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE worker boolean; name text;
BEGIN
  FOREACH worker IN ARRAY ARRAY[false,true] LOOP
    name=orbita_private.authority_name(wanted,worker);
    IF to_regclass('orbita_private.'||name) IS NULL THEN
      EXECUTE format('CREATE SEQUENCE orbita_private.%I AS bigint START WITH 1 INCREMENT BY 1 CACHE 1 NO CYCLE',name);
      EXECUTE format('REVOKE ALL ON SEQUENCE orbita_private.%I FROM PUBLIC,orbita_runtime',name);
      -- Mark 1 as used: the first revocation must advance to a distinct value.
      PERFORM nextval(('orbita_private.'||name)::regclass);
    END IF;
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION orbita_private.authority_value(wanted uuid,worker boolean)
RETURNS bigint LANGUAGE plpgsql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE value bigint;
BEGIN
  -- last_value is shared sequence state; currval would be session-local.
  -- Reading it does not write, acquire a row lock, or replace the data snapshot.
  EXECUTE format('SELECT last_value FROM orbita_private.%I',orbita_private.authority_name(wanted,worker)) INTO STRICT value;
  RETURN value;
END $$;
CREATE OR REPLACE FUNCTION orbita_private.advance_authority(wanted uuid,worker boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('managed-admission:'||wanted::text,0));
  PERFORM nextval(('orbita_private.'||orbita_private.authority_name(wanted,worker))::regclass);
END $$;
CREATE OR REPLACE FUNCTION orbita_private.workspace_authority_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN PERFORM orbita_private.prepare_authority(NEW.id);RETURN NEW; END IF;
  IF TG_OP='DELETE' THEN
    PERFORM orbita_private.advance_authority(OLD.id,false);
    PERFORM orbita_private.advance_authority(OLD.id,true);RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'ORBITA_PG_WORKSPACE_ID_IMMUTABLE'; END IF;
  IF (NEW.active,NEW.kind,NEW.parent_id) IS DISTINCT FROM (OLD.active,OLD.kind,OLD.parent_id) THEN
    PERFORM orbita_private.advance_authority(OLD.id,false);
  END IF;
  IF (NEW.capability_hash,NEW.capability_secret) IS DISTINCT FROM (OLD.capability_hash,OLD.capability_secret) THEN
    PERFORM orbita_private.advance_authority(OLD.id,true);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS workspace_authority_changed ON orbita_private.workspaces;
CREATE TRIGGER workspace_authority_changed BEFORE INSERT OR UPDATE OR DELETE ON orbita_private.workspaces
FOR EACH ROW EXECUTE FUNCTION orbita_private.workspace_authority_changed();
DO $$ DECLARE wanted uuid; BEGIN
  FOR wanted IN SELECT id FROM orbita_private.workspaces
    WHERE to_regclass('orbita_private.'||orbita_private.authority_name(id,false)) IS NULL
      OR to_regclass('orbita_private.'||orbita_private.authority_name(id,true)) IS NULL LOOP
    PERFORM orbita_private.prepare_authority(wanted);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION orbita_private.admission_workspace(wanted uuid)
RETURNS orbita_private.workspaces LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous_parent uuid; locked uuid; w orbita_private.workspaces%ROWTYPE;
BEGIN
  SELECT parent_id INTO previous_parent FROM orbita_private.workspaces WHERE id=wanted;
  IF NOT FOUND THEN RETURN w; END IF;
  -- Lock both identities before reading policy or capturing fences. A parent
  -- change between discovery and lock acquisition fails, without hidden retry.
  FOR locked IN SELECT value FROM (VALUES(wanted),(previous_parent)) ids(value)
    WHERE value IS NOT NULL GROUP BY value ORDER BY value LOOP
    -- Admitted clients may coexist. Revocation and purge take the exclusive
    -- form, so they still wait for every pending admission to finish.
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('managed-admission:'||locked::text,0));
  END LOOP;
  SELECT * INTO w FROM orbita_private.workspaces WHERE id=wanted AND active;
  IF w.id IS NOT NULL AND w.parent_id IS DISTINCT FROM previous_parent THEN
    RAISE EXCEPTION 'ORBITA_PG_ACCESS_DENIED' USING ERRCODE='28000';
  END IF;
  RETURN w;
END $$;
CREATE OR REPLACE FUNCTION orbita_private.admit_session(w orbita_private.workspaces,readonly boolean,is_maintenance boolean,epoch bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE started timestamptz;
BEGIN
  PERFORM pg_stat_clear_snapshot();
  SELECT backend_start INTO STRICT started FROM pg_catalog.pg_stat_get_activity(pg_backend_pid());
  DELETE FROM orbita_private.insert_events WHERE pid=pg_backend_pid() AND backend_start=started;
  -- An activity snapshot can predate a newly admitted backend. Never prune
  -- another PID from that snapshot; only our own reused identity is safe.
  DELETE FROM orbita_private.sessions
    WHERE pid=pg_backend_pid() AND backend_start<>started;
  INSERT INTO orbita_private.sessions(pid,backend_start,workspace_id,store_id,read_only,maintenance,worker_epoch,
    authority_fence,worker_fence,parent_fence)
    VALUES(pg_backend_pid(),started,w.id,NULL,readonly,is_maintenance,epoch,
      orbita_private.authority_value(w.id,false),orbita_private.authority_value(w.id,true),
      orbita_private.authority_value(w.parent_id,false))
    ON CONFLICT(pid,backend_start) DO UPDATE SET workspace_id=excluded.workspace_id,store_id=NULL,
      read_only=excluded.read_only,maintenance=excluded.maintenance,worker_epoch=excluded.worker_epoch,
      authority_fence=excluded.authority_fence,worker_fence=excluded.worker_fence,parent_fence=excluded.parent_fence,
      insert_serial=0,last_insert_rowid=NULL;
END $$;
CREATE OR REPLACE FUNCTION orbita_private.session_fences_current(s orbita_private.sessions,parent uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT COALESCE((s).authority_fence=orbita_private.authority_value((s).workspace_id,false)
    AND ((s).maintenance OR (s).worker_fence=orbita_private.authority_value((s).workspace_id,true))
    AND (parent IS NULL OR (s).parent_fence=orbita_private.authority_value(parent,false)),false)
$$;
CREATE OR REPLACE FUNCTION orbita_private.visible_session()
RETURNS SETOF orbita_private.sessions LANGUAGE sql STABLE SECURITY DEFINER ROWS 1 SET search_path=pg_catalog AS $$
  SELECT s.* FROM orbita_private.sessions s JOIN orbita_private.workspaces w ON w.id=s.workspace_id
    WHERE s.pid=pg_backend_pid() AND w.active AND w.kind<>'managed'
      AND s.backend_start=(SELECT backend_start FROM pg_catalog.pg_stat_get_activity(pg_backend_pid()))
      AND orbita_private.session_fences_current(s,w.parent_id)
$$;
CREATE OR REPLACE FUNCTION orbita_common.workspace_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT s.workspace_id FROM orbita_private.visible_session() s
$$;
CREATE OR REPLACE FUNCTION orbita_common.store_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT s.store_id FROM orbita_private.visible_session() s
$$;
CREATE OR REPLACE FUNCTION orbita_common.can_write() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT COALESCE((SELECT NOT s.read_only FROM orbita_private.visible_session() s),false)
$$;
CREATE OR REPLACE FUNCTION orbita_common.authorize_workspace(wanted uuid,capability text,readonly boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w orbita_private.workspaces%ROWTYPE;
BEGIN
  IF session_user<>'orbita_runtime' OR capability IS NULL OR readonly IS NULL OR wanted IS NULL
    OR length(capability) NOT BETWEEN 32 AND 256 THEN
    RAISE EXCEPTION 'ORBITA_PG_ACCESS_DENIED' USING ERRCODE='28000'; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'ORBITA_PG_ADMISSION_READ_COMMITTED_REQUIRED' USING ERRCODE='25001'; END IF;
  w=orbita_private.admission_workspace(wanted);
  IF w.id IS NULL OR w.kind='managed' OR w.capability_hash<>sha256(convert_to(capability,'UTF8')) THEN
    RAISE EXCEPTION 'ORBITA_PG_ACCESS_DENIED' USING ERRCODE='28000'; END IF;
  PERFORM orbita_private.admit_session(w,readonly,false,NULL);
END $$;

REVOKE ALL ON FUNCTION orbita_private.authority_name(uuid,boolean),orbita_private.prepare_authority(uuid),
  orbita_private.authority_value(uuid,boolean),orbita_private.advance_authority(uuid,boolean),
  orbita_private.workspace_authority_changed(),orbita_private.admission_workspace(uuid),
  orbita_private.admit_session(orbita_private.workspaces,boolean,boolean,bigint),
  orbita_private.session_fences_current(orbita_private.sessions,uuid),orbita_private.visible_session() FROM PUBLIC,orbita_runtime;
REVOKE ALL ON FUNCTION orbita_common.authorize_workspace(uuid,text,boolean),orbita_common.workspace_id(),orbita_common.store_id(),orbita_common.can_write() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orbita_common.authorize_workspace(uuid,text,boolean),orbita_common.workspace_id(),orbita_common.store_id(),orbita_common.can_write() TO orbita_runtime;

-- Reveal only the currently authenticated workspace kind for explicit launchers.
CREATE OR REPLACE FUNCTION orbita_common.workspace_kind() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT kind FROM orbita_private.workspaces WHERE id=orbita_common.workspace_id()
$$;
REVOKE ALL ON FUNCTION orbita_common.workspace_kind() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orbita_common.workspace_kind() TO orbita_runtime;
