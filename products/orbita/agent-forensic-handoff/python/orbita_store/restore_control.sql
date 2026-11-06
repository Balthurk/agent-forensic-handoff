-- This control state is not a file or logical store and is never part of a
-- content backup, clone, purge or import. Full service backups retain it.
CREATE TABLE IF NOT EXISTS orbita_private.restore_controls (
  workspace_id uuid NOT NULL REFERENCES orbita_private.workspaces(id),
  logical_root text NOT NULL, state jsonb NOT NULL,
  PRIMARY KEY(workspace_id,logical_root)
);
CREATE TABLE IF NOT EXISTS orbita_private.restore_control_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES orbita_private.workspaces(id),
  logical_root text NOT NULL, action text NOT NULL CHECK(action IN ('prepare','activate')),
  state jsonb NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON orbita_private.restore_controls,orbita_private.restore_control_events FROM PUBLIC,orbita_runtime;

CREATE OR REPLACE FUNCTION orbita_common.restore_state(wanted_root text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE workspace uuid;
BEGIN
  workspace=orbita_common.workspace_id();
  IF workspace IS NULL THEN RAISE EXCEPTION 'ORBITA_PG_ACCESS_DENIED' USING ERRCODE='28000'; END IF;
  RETURN (SELECT state FROM orbita_private.restore_controls WHERE workspace_id=workspace AND logical_root=wanted_root);
END $$;

CREATE OR REPLACE FUNCTION orbita_common.prepare_restore(wanted_root text,wanted_state jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE workspace uuid; result jsonb;
BEGIN
  workspace=orbita_common.workspace_id();
  IF workspace IS NULL OR NOT orbita_common.can_write() THEN RAISE EXCEPTION 'ORBITA_PG_READ_ONLY' USING ERRCODE='25006'; END IF;
  IF wanted_root IS NULL OR length(wanted_root) NOT BETWEEN 1 AND 4096
    OR wanted_root ~ '(^/|/$|//|(^|/)\.{1,2}(/|$)|\\|:|[[:cntrl:]])'
    OR jsonb_typeof(wanted_state) IS DISTINCT FROM 'object' OR octet_length(wanted_state::text)>1048576
    OR wanted_state->>'schema' IS DISTINCT FROM 'orbita-restore-2' OR wanted_state->>'id' IS NULL THEN
    RAISE EXCEPTION 'ORBITA_PG_RESTORE_CONTROL_STATE'; END IF;
  PERFORM (wanted_state->>'id')::uuid;
  result=(wanted_state-'activationAt') || jsonb_build_object('automaticWork',false,'externalAccess',false);
  INSERT INTO orbita_private.restore_controls(workspace_id,logical_root,state) VALUES(workspace,wanted_root,result)
    ON CONFLICT ON CONSTRAINT restore_controls_pkey DO UPDATE SET state=excluded.state;
  INSERT INTO orbita_private.restore_control_events(workspace_id,logical_root,action,state) VALUES(workspace,wanted_root,'prepare',result);
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION orbita_common.activate_restore(wanted_root text,restore_id text,automatic_work boolean,external_access boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE workspace uuid; result jsonb;
BEGIN
  workspace=orbita_common.workspace_id();
  IF workspace IS NULL OR NOT orbita_common.can_write() THEN RAISE EXCEPTION 'ORBITA_PG_READ_ONLY' USING ERRCODE='25006'; END IF;
  IF automatic_work IS NULL OR external_access IS NULL THEN RAISE EXCEPTION 'ORBITA_PG_RESTORE_ACTIVATION_FLAGS'; END IF;
  SELECT state INTO result FROM orbita_private.restore_controls WHERE workspace_id=workspace AND logical_root=wanted_root FOR UPDATE;
  IF result IS NULL OR result->>'id' IS DISTINCT FROM restore_id THEN RAISE EXCEPTION 'ORBITA_PG_RESTORE_ID'; END IF;
  result=result || jsonb_build_object('automaticWork',automatic_work,'externalAccess',external_access,'activationAt',clock_timestamp());
  UPDATE orbita_private.restore_controls SET state=result WHERE workspace_id=workspace AND logical_root=wanted_root;
  INSERT INTO orbita_private.restore_control_events(workspace_id,logical_root,action,state) VALUES(workspace,wanted_root,'activate',result);
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION orbita_common.restore_state(text),orbita_common.prepare_restore(text,jsonb),
  orbita_common.activate_restore(text,text,boolean,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orbita_common.restore_state(text),orbita_common.prepare_restore(text,jsonb),
  orbita_common.activate_restore(text,text,boolean,boolean) TO orbita_runtime;
