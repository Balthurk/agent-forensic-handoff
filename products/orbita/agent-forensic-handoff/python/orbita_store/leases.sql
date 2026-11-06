-- Control-plane leases use the live PostgreSQL backend identity. They have no
-- wall-clock expiry and never infer ownership from a recycled client PID.
CREATE TABLE IF NOT EXISTS orbita_private.store_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES orbita_private.workspaces(id),
  pid integer NOT NULL,
  backend_start timestamptz NOT NULL,
  root text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('shared','exclusive')),
  FOREIGN KEY(pid,backend_start) REFERENCES orbita_private.sessions(pid,backend_start) ON DELETE CASCADE
);
REVOKE ALL ON orbita_private.store_leases FROM PUBLIC,orbita_runtime;

CREATE OR REPLACE FUNCTION orbita_common.acquire_store_lease(wanted_root text,wanted_mode text,own_shared uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE workspace uuid; started timestamptz; token uuid;
BEGIN
  workspace=orbita_common.workspace_id();
  IF workspace IS NULL OR NOT orbita_common.can_write() THEN RAISE EXCEPTION 'ORBITA_PG_LEASE_ACCESS_DENIED' USING ERRCODE='28000'; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ORBITA_PG_LEASE_READ_COMMITTED_REQUIRED' USING ERRCODE='25001'; END IF;
  IF wanted_root IS NULL OR length(wanted_root)>4096 OR wanted_root ~ '(^/|/$|//|(^|/)\.\.(/|$)|\\|:|[[:cntrl:]])'
    OR wanted_mode IS NULL OR wanted_mode NOT IN ('shared','exclusive') THEN
    RAISE EXCEPTION 'ORBITA_PG_LEASE_ARGUMENT' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('leases:' || workspace::text,0));
  PERFORM pg_stat_clear_snapshot();
  SELECT backend_start INTO STRICT started FROM pg_catalog.pg_stat_get_activity(pg_backend_pid());
  DELETE FROM orbita_private.store_leases l WHERE l.workspace_id=workspace AND NOT EXISTS
    (SELECT 1 FROM pg_stat_activity a WHERE a.pid=l.pid AND a.backend_start=l.backend_start);
  IF own_shared IS NOT NULL AND (wanted_mode<>'exclusive' OR NOT EXISTS
    (SELECT 1 FROM orbita_private.store_leases l WHERE l.id=own_shared AND l.workspace_id=workspace
      AND l.pid=pg_backend_pid() AND l.backend_start=started AND l.root=wanted_root AND l.mode='shared')) THEN
    RAISE EXCEPTION 'ORBITA_PG_LEASE_OWNERSHIP' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM orbita_private.store_leases l WHERE l.workspace_id=workspace AND l.id IS DISTINCT FROM own_shared
    AND (l.mode='exclusive' OR wanted_mode='exclusive')
    AND (l.root='' OR wanted_root='' OR l.root=wanted_root OR starts_with(l.root,wanted_root || '/') OR starts_with(wanted_root,l.root || '/'))) THEN
    RAISE EXCEPTION 'ORBITA_PG_LEASE_BUSY' USING ERRCODE='55P03'; END IF;
  INSERT INTO orbita_private.store_leases(workspace_id,pid,backend_start,root,mode)
    VALUES(workspace,pg_backend_pid(),started,wanted_root,wanted_mode) RETURNING id INTO token;
  RETURN token;
END $$;

CREATE OR REPLACE FUNCTION orbita_common.release_store_lease(wanted uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE count_deleted bigint;
BEGIN
  IF orbita_common.workspace_id() IS NULL THEN RAISE EXCEPTION 'ORBITA_PG_LEASE_ACCESS_DENIED' USING ERRCODE='28000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('leases:' || orbita_common.workspace_id()::text,0));
  DELETE FROM orbita_private.store_leases WHERE id=wanted AND workspace_id=orbita_common.workspace_id()
    AND pid=pg_backend_pid() AND backend_start=(SELECT backend_start FROM pg_catalog.pg_stat_get_activity(pg_backend_pid()));
  GET DIAGNOSTICS count_deleted=ROW_COUNT;
  RETURN count_deleted=1;
END $$;
REVOKE ALL ON FUNCTION orbita_common.acquire_store_lease(text,text,uuid),orbita_common.release_store_lease(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orbita_common.acquire_store_lease(text,text,uuid),orbita_common.release_store_lease(uuid) TO orbita_runtime;
