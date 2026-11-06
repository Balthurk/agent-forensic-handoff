-- Installed after the access family. All managed content remains in this DB.
-- Capabilities and lifecycle tombstones are private control state, never part
-- of a content export/restore. Public routines derive the caller's control.
ALTER TABLE orbita_private.sessions ADD COLUMN IF NOT EXISTS maintenance boolean NOT NULL DEFAULT false;
ALTER TABLE orbita_private.sessions ADD COLUMN IF NOT EXISTS worker_epoch bigint;
CREATE TABLE IF NOT EXISTS orbita_private.managed_workspaces (
  control_store_id uuid NOT NULL,
  local_id text NOT NULL,
  workspace_id uuid NOT NULL UNIQUE REFERENCES orbita_private.workspaces(id),
  epoch bigint NOT NULL DEFAULT 1 CHECK(epoch>0),
  maintenance_secret text NOT NULL,
  maintenance_hash bytea NOT NULL,
  status text NOT NULL CHECK(status IN ('active','suspended','maintenance','purge_prepared','purge_failed','purged')),
  rights_until timestamptz,
  retain_until timestamptz,
  purge_receipt jsonb,
  PRIMARY KEY(control_store_id,local_id),
  FOREIGN KEY(control_store_id,local_id) REFERENCES orbita_access.workspaces(_store_id,id)
);
REVOKE ALL ON orbita_private.managed_workspaces FROM PUBLIC,orbita_runtime;

CREATE OR REPLACE FUNCTION orbita_private.managed_authority_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM orbita_private.advance_authority(NEW.workspace_id,false);
    PERFORM orbita_private.advance_authority(NEW.workspace_id,true);RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    PERFORM orbita_private.advance_authority(OLD.workspace_id,false);
    PERFORM orbita_private.advance_authority(OLD.workspace_id,true);RETURN OLD;
  END IF;
  IF (NEW.workspace_id,NEW.control_store_id,NEW.local_id) IS DISTINCT FROM (OLD.workspace_id,OLD.control_store_id,OLD.local_id) THEN
    RAISE EXCEPTION 'ORBITA_PG_MANAGED_ID_IMMUTABLE'; END IF;
  IF (NEW.maintenance_hash,NEW.maintenance_secret,NEW.purge_receipt) IS DISTINCT FROM (OLD.maintenance_hash,OLD.maintenance_secret,OLD.purge_receipt) THEN
    PERFORM orbita_private.advance_authority(OLD.workspace_id,false);
  END IF;
  IF (NEW.epoch,NEW.status,NEW.rights_until,NEW.retain_until) IS DISTINCT FROM (OLD.epoch,OLD.status,OLD.rights_until,OLD.retain_until) THEN
    PERFORM orbita_private.advance_authority(OLD.workspace_id,true);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS managed_authority_changed ON orbita_private.managed_workspaces;
CREATE TRIGGER managed_authority_changed BEFORE INSERT OR UPDATE OR DELETE ON orbita_private.managed_workspaces
FOR EACH ROW EXECUTE FUNCTION orbita_private.managed_authority_changed();
REVOKE ALL ON FUNCTION orbita_private.managed_authority_changed() FROM PUBLIC,orbita_runtime;

CREATE OR REPLACE FUNCTION orbita_private.visible_session()
RETURNS SETOF orbita_private.sessions LANGUAGE plpgsql STABLE SECURITY DEFINER ROWS 1 SET search_path=pg_catalog AS $$
DECLARE identity record; authorized orbita_private.sessions%ROWTYPE;
BEGIN
  -- Private sequence fences are visible even from an older READ ONLY snapshot.
  -- Policy rows alone would let RR/SSI readers retain revoked authority.
  SELECT s,w.kind,w.parent_id INTO identity FROM orbita_private.sessions s
    JOIN orbita_private.workspaces w ON w.id=s.workspace_id
    WHERE s.pid=pg_backend_pid() AND w.active
      AND s.backend_start=(SELECT backend_start FROM pg_catalog.pg_stat_get_activity(pg_backend_pid()));
  IF NOT FOUND THEN RETURN; END IF;
  authorized=identity.s;
  IF NOT orbita_private.session_fences_current(authorized,identity.parent_id) THEN RETURN; END IF;
  IF identity.kind='managed' AND NOT EXISTS(
    SELECT 1 FROM orbita_private.managed_workspaces m JOIN orbita_private.workspaces p ON p.id=identity.parent_id
      WHERE m.workspace_id=authorized.workspace_id AND p.active AND m.purge_receipt IS NULL
        AND (authorized.maintenance OR (authorized.worker_epoch=m.epoch AND m.status='active'
          AND m.rights_until>statement_timestamp() AND m.retain_until>statement_timestamp()))) THEN RETURN; END IF;
  RETURN NEXT authorized;
END
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

CREATE OR REPLACE FUNCTION orbita_common.authorize_workspace(wanted uuid, capability text, readonly boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w orbita_private.workspaces%ROWTYPE;
  m orbita_private.managed_workspaces%ROWTYPE; is_maintenance boolean=false; admitted boolean=false;
BEGIN
  IF session_user<>'orbita_runtime' OR capability IS NULL OR readonly IS NULL
    OR wanted IS NULL OR length(capability) NOT BETWEEN 32 AND 256 THEN
    RAISE EXCEPTION 'ORBITA_PG_ACCESS_DENIED' USING ERRCODE='28000'; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'ORBITA_PG_ADMISSION_READ_COMMITTED_REQUIRED' USING ERRCODE='25001'; END IF;
  -- Fresh RC policy after both child and parent admission locks are held.
  w=orbita_private.admission_workspace(wanted);
  IF w.id IS NOT NULL THEN
    IF w.kind='managed' THEN
      SELECT * INTO m FROM orbita_private.managed_workspaces WHERE workspace_id=wanted;
      IF m.workspace_id IS NOT NULL AND m.purge_receipt IS NULL
        AND EXISTS(SELECT 1 FROM orbita_private.workspaces WHERE id=w.parent_id AND active) THEN
        is_maintenance=m.maintenance_hash=sha256(convert_to(capability,'UTF8'));
        admitted=is_maintenance OR (w.capability_hash=sha256(convert_to(capability,'UTF8'))
          AND m.status='active' AND m.rights_until>clock_timestamp() AND m.retain_until>clock_timestamp());
      END IF;
    ELSE admitted=w.capability_hash=sha256(convert_to(capability,'UTF8')); END IF;
  END IF;
  IF NOT COALESCE(admitted,false) THEN RAISE EXCEPTION 'ORBITA_PG_ACCESS_DENIED' USING ERRCODE='28000'; END IF;
  PERFORM orbita_private.admit_session(w,readonly,is_maintenance,m.epoch);
END $$;

CREATE OR REPLACE FUNCTION orbita_private.control_store(writable boolean) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result uuid;
BEGIN
  SELECT t.id INTO result FROM orbita_private.stores t JOIN orbita_private.workspaces w ON w.id=t.workspace_id
    WHERE t.id=orbita_common.store_id() AND t.workspace_id=orbita_common.workspace_id()
      AND t.family='access' AND w.kind IN ('control','test') AND w.active;
  IF result IS NULL OR (writable AND NOT orbita_common.can_write()) THEN
    RAISE EXCEPTION 'ORBITA_PG_CONTROL_AUTHORITY_REQUIRED' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION orbita_private.managed_policy(payload jsonb)
RETURNS TABLE(status text,rights_until timestamptz,retain_until timestamptz)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
BEGIN
  status=payload->>'status';
  IF status IS NULL OR status NOT IN ('active','suspended','maintenance','purge_prepared','purge_failed','purged') THEN
    RAISE EXCEPTION 'ORBITA_PG_MANAGED_STATUS'; END IF;
  IF status='purged' THEN RETURN NEXT; RETURN; END IF;
  IF COALESCE(payload#>>'{policy,rightsUntil}','') !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$'
    OR COALESCE(payload#>>'{policy,retainUntil}','') !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$' THEN
    RAISE EXCEPTION 'ORBITA_PG_MANAGED_POLICY_DATES'; END IF;
  rights_until=(payload#>>'{policy,rightsUntil}')::timestamptz;
  retain_until=(payload#>>'{policy,retainUntil}')::timestamptz;
  RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION orbita_private.rotate_managed(wanted_store uuid,wanted_local text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE child uuid; secret text;
BEGIN
  UPDATE orbita_private.managed_workspaces SET epoch=epoch+1
    WHERE control_store_id=wanted_store AND local_id=wanted_local RETURNING workspace_id INTO child;
  IF child IS NOT NULL THEN
    secret=encode(orbita_private.gen_random_bytes(32),'hex');
    UPDATE orbita_private.workspaces SET capability_secret=secret,capability_hash=sha256(convert_to(secret,'UTF8')) WHERE id=child;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION orbita_private.managed_workspace_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE m orbita_private.managed_workspaces%ROWTYPE; policy record;
BEGIN
  SELECT * INTO m FROM orbita_private.managed_workspaces WHERE control_store_id=OLD._store_id AND local_id=OLD.id FOR UPDATE;
  IF m.workspace_id IS NULL THEN RETURN NEW; END IF;
  IF NEW._store_id IS DISTINCT FROM OLD._store_id OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.payload::jsonb->>'id' IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'ORBITA_PG_MANAGED_ID_IMMUTABLE'; END IF;
  SELECT * INTO STRICT policy FROM orbita_private.managed_policy(NEW.payload::jsonb);
  IF (policy.status='purged' AND m.purge_receipt IS NULL)
    OR (m.purge_receipt IS NOT NULL AND policy.status NOT IN ('purge_prepared','purge_failed','purged')) THEN
    RAISE EXCEPTION 'ORBITA_PG_MANAGED_PURGE_STATE'; END IF;
  IF (m.status,m.rights_until,m.retain_until) IS DISTINCT FROM (policy.status,policy.rights_until,policy.retain_until) THEN
    UPDATE orbita_private.managed_workspaces SET status=policy.status,rights_until=policy.rights_until,retain_until=policy.retain_until
      WHERE control_store_id=m.control_store_id AND local_id=m.local_id;
    PERFORM orbita_private.rotate_managed(m.control_store_id,m.local_id);
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION orbita_private.managed_membership_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN PERFORM orbita_private.rotate_managed(OLD._store_id,OLD.workspace); END IF;
  IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND (NEW._store_id,NEW.workspace) IS DISTINCT FROM (OLD._store_id,OLD.workspace)) THEN
    PERFORM orbita_private.rotate_managed(NEW._store_id,NEW.workspace); END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS managed_workspace_changed ON orbita_access.workspaces;
CREATE TRIGGER managed_workspace_changed BEFORE UPDATE ON orbita_access.workspaces FOR EACH ROW EXECUTE FUNCTION orbita_private.managed_workspace_changed();
DROP TRIGGER IF EXISTS managed_membership_changed ON orbita_access.members;
CREATE TRIGGER managed_membership_changed AFTER INSERT OR UPDATE OR DELETE ON orbita_access.members FOR EACH ROW EXECUTE FUNCTION orbita_private.managed_membership_changed();

CREATE OR REPLACE FUNCTION orbita_common.provision_managed(wanted_local text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE control uuid; parent uuid; child uuid; body jsonb; policy record; worker_secret text; maintenance_secret text;
  object uuid; library_bytes bytea=convert_to('[]','UTF8'); existing orbita_private.managed_workspaces%ROWTYPE;
BEGIN
  control=orbita_private.control_store(true);parent=orbita_common.workspace_id();
  IF wanted_local IS NULL OR wanted_local !~ '^ws-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN
    RAISE EXCEPTION 'ORBITA_PG_MANAGED_ID'; END IF;
  SELECT payload::jsonb INTO body FROM orbita_access.workspaces WHERE _store_id=control AND id=wanted_local FOR UPDATE;
  IF body IS NULL OR body->>'id' IS DISTINCT FROM wanted_local OR NOT EXISTS
    (SELECT 1 FROM orbita_access.members m JOIN orbita_access.users u ON u._store_id=m._store_id AND u.id=m."user"
      WHERE m._store_id=control AND m.workspace=wanted_local AND m."user"=body->>'owner' AND m.role='owner' AND u.enabled=1) THEN
    RAISE EXCEPTION 'ORBITA_PG_MANAGED_OWNER_REQUIRED'; END IF;
  SELECT * INTO existing FROM orbita_private.managed_workspaces WHERE control_store_id=control AND local_id=wanted_local;
  IF existing.workspace_id IS NOT NULL THEN
    IF existing.purge_receipt IS NOT NULL THEN RAISE EXCEPTION 'ORBITA_PG_MANAGED_PURGED'; END IF;
    RETURN jsonb_build_object('workspaceId',existing.workspace_id,'epoch',existing.epoch,'created',false);
  END IF;
  SELECT * INTO STRICT policy FROM orbita_private.managed_policy(body);
  IF policy.status<>'active' OR policy.rights_until<=clock_timestamp() OR policy.retain_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'ORBITA_PG_MANAGED_INITIAL_POLICY'; END IF;
  child=gen_random_uuid();worker_secret=encode(orbita_private.gen_random_bytes(32),'hex');maintenance_secret=encode(orbita_private.gen_random_bytes(32),'hex');
  INSERT INTO orbita_private.workspaces(id,label,kind,parent_id,capability_hash,capability_secret)
    VALUES(child,wanted_local,'managed',parent,sha256(convert_to(worker_secret,'UTF8')),worker_secret);
  INSERT INTO orbita_private.managed_workspaces(control_store_id,local_id,workspace_id,maintenance_secret,maintenance_hash,status,rights_until,retain_until)
    VALUES(control,wanted_local,child,maintenance_secret,sha256(convert_to(maintenance_secret,'UTF8')),policy.status,policy.rights_until,policy.retain_until);
  INSERT INTO orbita_common.entries(workspace_id,path,kind) VALUES(child,'','directory'),(child,'data','directory');
  INSERT INTO orbita_common.objects(workspace_id) VALUES(child) RETURNING id INTO object;
  INSERT INTO orbita_common.chunk_blobs(workspace_id,bytes) VALUES(child,library_bytes);
  INSERT INTO orbita_common.object_chunks(workspace_id,object_id,ordinal,chunk_hash) VALUES(child,object,0,encode(sha256(library_bytes),'hex'));
  UPDATE orbita_common.objects SET size=2,sha256=encode(sha256(library_bytes),'hex'),complete=true WHERE workspace_id=child AND id=object;
  INSERT INTO orbita_common.entries(workspace_id,path,kind,object_id) VALUES(child,'data/library.json','file',object);
  RETURN jsonb_build_object('workspaceId',child,'epoch',1,'created',true);
END $$;

CREATE OR REPLACE FUNCTION orbita_common.managed_binding(wanted_local text,mode text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE control uuid; m orbita_private.managed_workspaces%ROWTYPE; secret text;
BEGIN
  control=orbita_private.control_store(true);
  IF mode IS NULL OR mode NOT IN ('state','worker','maintenance') THEN RAISE EXCEPTION 'ORBITA_PG_MANAGED_MODE'; END IF;
  SELECT * INTO m FROM orbita_private.managed_workspaces WHERE control_store_id=control AND local_id=wanted_local;
  IF m.workspace_id IS NULL THEN RAISE EXCEPTION 'ORBITA_PG_MANAGED_UNKNOWN' USING ERRCODE='P0002'; END IF;
  IF mode='state' THEN RETURN jsonb_build_object('workspaceId',m.workspace_id,'epoch',m.epoch,'purged',m.purge_receipt IS NOT NULL,'purge',m.purge_receipt); END IF;
  IF m.purge_receipt IS NOT NULL THEN RAISE EXCEPTION 'ORBITA_PG_MANAGED_PURGED' USING ERRCODE='28000'; END IF;
  IF mode='worker' THEN
    IF m.status<>'active' OR m.rights_until<=statement_timestamp() OR m.retain_until<=statement_timestamp() THEN
      RAISE EXCEPTION 'ORBITA_PG_MANAGED_INACTIVE' USING ERRCODE='28000'; END IF;
    SELECT capability_secret INTO STRICT secret FROM orbita_private.workspaces WHERE id=m.workspace_id AND active;
  ELSE secret=m.maintenance_secret; END IF;
  RETURN jsonb_build_object('workspaceId',m.workspace_id,'epoch',m.epoch,'capability',secret);
END $$;

CREATE OR REPLACE FUNCTION orbita_common.managed_control() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE control uuid;
BEGIN
  control=orbita_private.control_store(true);
  RETURN jsonb_build_object('storeId',control,'workspaceId',orbita_common.workspace_id());
END $$;

CREATE OR REPLACE FUNCTION orbita_common.worker_delegation_allowed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT COALESCE((SELECT NOT s.maintenance FROM orbita_private.visible_session() s),false)
$$;
REVOKE ALL ON FUNCTION orbita_common.worker_delegation_allowed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orbita_common.worker_delegation_allowed() TO orbita_runtime;

CREATE OR REPLACE FUNCTION orbita_common.managed_consumers(wanted_local text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE control uuid; child uuid; result jsonb;
BEGIN
  control=orbita_private.control_store(true);
  SELECT workspace_id INTO child FROM orbita_private.managed_workspaces WHERE control_store_id=control AND local_id=wanted_local;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORBITA_PG_MANAGED_UNKNOWN'; END IF;
  -- Revocation hides content; it must never hide a still-live consumer.
  PERFORM pg_stat_clear_snapshot();
  WITH consumers AS (
    SELECT s.pid,s.backend_start,'session' AS kind FROM orbita_private.sessions s WHERE s.workspace_id=child
    UNION ALL SELECT p.pid,p.backend_start,'pin' FROM orbita_private.object_pins p WHERE p.workspace_id=child
    UNION ALL SELECT l.pid,l.backend_start,'lease' FROM orbita_private.store_leases l WHERE l.workspace_id=child
  ), live AS (
    SELECT c.* FROM consumers c JOIN pg_stat_activity a ON a.pid=c.pid AND a.backend_start=c.backend_start
  ) SELECT jsonb_build_object('workspaceId',child,'backends',count(DISTINCT (pid,backend_start)),
      'sessions',count(*) FILTER(WHERE kind='session'),'pins',count(*) FILTER(WHERE kind='pin'),
      'leases',count(*) FILTER(WHERE kind='lease')) INTO result FROM live;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION orbita_common.purge_managed(wanted_local text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE control uuid; child uuid; m orbita_private.managed_workspaces%ROWTYPE; body jsonb; item record; rel record;
  started timestamptz; receipt jsonb; entries_count bigint; files_count bigint; bytes_count bigint;
  rows_count bigint=0; stores_count bigint=0; affected bigint;
BEGIN
  control=orbita_private.control_store(true);
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ORBITA_PG_PURGE_FRESH_AUTHORITY_REQUIRED'; END IF;
  SELECT workspace_id INTO child FROM orbita_private.managed_workspaces WHERE control_store_id=control AND local_id=wanted_local;
  IF child IS NULL THEN RAISE EXCEPTION 'ORBITA_PG_MANAGED_UNKNOWN' USING ERRCODE='P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('managed-admission:' || child::text,0));
  SELECT * INTO STRICT m FROM orbita_private.managed_workspaces WHERE control_store_id=control AND local_id=wanted_local FOR UPDATE;
  IF m.purge_receipt IS NOT NULL THEN RETURN m.purge_receipt; END IF;
  SELECT payload::jsonb INTO STRICT body FROM orbita_access.workspaces WHERE _store_id=control AND id=wanted_local;
  IF m.status NOT IN ('purge_prepared','purge_failed') OR body->>'legalHold' IS DISTINCT FROM 'false'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(body->'externalCopies') e WHERE e->>'state'='outstanding') THEN
    RAISE EXCEPTION 'ORBITA_PG_MANAGED_PURGE_NOT_PREPARED'; END IF;
  PERFORM pg_stat_clear_snapshot();
  IF EXISTS(SELECT 1 FROM orbita_private.sessions s JOIN pg_stat_activity a ON a.pid=s.pid AND a.backend_start=s.backend_start
    WHERE s.workspace_id=child)
    OR EXISTS(SELECT 1 FROM orbita_private.object_pins p JOIN pg_stat_activity a ON a.pid=p.pid AND a.backend_start=p.backend_start WHERE p.workspace_id=child)
    OR EXISTS(SELECT 1 FROM orbita_private.store_leases l JOIN pg_stat_activity a ON a.pid=l.pid AND a.backend_start=l.backend_start WHERE l.workspace_id=child)
    THEN RAISE EXCEPTION 'ORBITA_PG_MANAGED_LIVE_CONSUMER' USING ERRCODE='55006'; END IF;
  SELECT backend_start INTO STRICT started FROM pg_catalog.pg_stat_get_activity(pg_backend_pid());
  SELECT count(*),count(*) FILTER(WHERE e.kind='file'),COALESCE(sum(o.size),0) INTO entries_count,files_count,bytes_count
    FROM orbita_common.entries e LEFT JOIN orbita_common.objects o ON o.workspace_id=e.workspace_id AND o.id=e.object_id WHERE e.workspace_id=child;
  FOR item IN SELECT * FROM orbita_private.stores WHERE workspace_id=child ORDER BY id LOOP
    INSERT INTO orbita_private.tree_operations VALUES(pg_backend_pid(),started,txid_current(),item.id,'purge');
    FOR rel IN SELECT * FROM orbita_private.ordered_tables(item.family) ORDER BY copy_order DESC LOOP
      EXECUTE format('DELETE FROM %I.%I WHERE _store_id=$1','orbita_' || item.family,rel.table_name) USING item.id;
      GET DIAGNOSTICS affected=ROW_COUNT;rows_count=rows_count+affected;
    END LOOP;
    DELETE FROM orbita_private.tree_operations WHERE pid=pg_backend_pid() AND backend_start=started AND transaction_id=txid_current() AND store_id=item.id;
    DELETE FROM orbita_private.sessions WHERE store_id=item.id;
    DELETE FROM orbita_private.row_counters WHERE store_id=item.id;
    DELETE FROM orbita_private.store_catalog WHERE store_id=item.id;
    DELETE FROM orbita_common.entries WHERE workspace_id=child AND store_id=item.id;
    DELETE FROM orbita_private.stores WHERE id=item.id;
    stores_count=stores_count+1;
  END LOOP;
  DELETE FROM orbita_private.sessions WHERE workspace_id=child;
  DELETE FROM orbita_private.object_pins WHERE workspace_id=child;
  DELETE FROM orbita_common.entries WHERE workspace_id=child;
  DELETE FROM orbita_common.object_chunks WHERE workspace_id=child;
  DELETE FROM orbita_common.objects WHERE workspace_id=child;
  DELETE FROM orbita_common.chunk_blobs WHERE workspace_id=child;
  DELETE FROM orbita_private.restore_controls WHERE workspace_id=child;
  DELETE FROM orbita_private.restore_control_events WHERE workspace_id=child;
  receipt=jsonb_build_object('id',gen_random_uuid(),'workspaceId',child,'at',clock_timestamp(),
    'entries',entries_count,'files',files_count,'bytes',bytes_count,'stores',stores_count,'rows',rows_count,'purged',true,'physicalErasure',false);
  UPDATE orbita_private.managed_workspaces SET purge_receipt=receipt,epoch=epoch+1 WHERE workspace_id=child;
  UPDATE orbita_private.workspaces SET active=false WHERE id=child;
  RETURN receipt;
END $$;

REVOKE ALL ON FUNCTION orbita_private.visible_session(),orbita_private.control_store(boolean),orbita_private.managed_policy(jsonb),
  orbita_private.rotate_managed(uuid,text),orbita_private.managed_workspace_changed(),orbita_private.managed_membership_changed(),
  orbita_common.provision_managed(text),orbita_common.managed_binding(text,text),orbita_common.purge_managed(text),orbita_common.managed_control(),orbita_common.managed_consumers(text) FROM PUBLIC,orbita_runtime;
GRANT EXECUTE ON FUNCTION orbita_common.provision_managed(text),orbita_common.managed_binding(text,text),orbita_common.purge_managed(text),orbita_common.managed_control(),orbita_common.managed_consumers(text) TO orbita_runtime;
