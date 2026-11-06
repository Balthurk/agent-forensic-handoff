-- Operator publication receipts and legacy archive bindings are control state.
-- They never enter a logical content export or an ordinary legacy import.
CREATE TABLE IF NOT EXISTS orbita_private.managed_publications (
  operation_id uuid PRIMARY KEY,
  request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  control_workspace_id uuid NOT NULL UNIQUE REFERENCES orbita_private.workspaces(id),
  receipt jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS orbita_private.managed_legacy_archives (
  control_store_id uuid NOT NULL,
  archive_id text NOT NULL,
  local_id text NOT NULL,
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  ciphertext_sha256 text NOT NULL CHECK(ciphertext_sha256 ~ '^[a-f0-9]{64}$'),
  logical_key text NOT NULL,
  PRIMARY KEY(control_store_id,archive_id),
  FOREIGN KEY(control_store_id,archive_id) REFERENCES orbita_access.archives(_store_id,id) ON DELETE CASCADE,
  FOREIGN KEY(control_store_id,local_id) REFERENCES orbita_private.managed_workspaces(control_store_id,local_id),
  CHECK(archive_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  CHECK(logical_key='backups/'||archive_id||'.orbita')
);
REVOKE ALL ON orbita_private.managed_publications,orbita_private.managed_legacy_archives FROM PUBLIC,orbita_runtime;

CREATE OR REPLACE FUNCTION orbita_common.managed_legacy_archive(wanted_local text,wanted_archive text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE control uuid; result jsonb;
BEGIN
  control=orbita_private.control_store(true);
  SELECT jsonb_build_object('logicalKey',b.logical_key,'sha256',b.ciphertext_sha256) INTO result
    FROM orbita_private.managed_legacy_archives b
    JOIN orbita_access.archives a ON a._store_id=b.control_store_id AND a.id=b.archive_id AND a.workspace=b.local_id
    JOIN orbita_private.managed_workspaces m ON m.control_store_id=b.control_store_id AND m.local_id=b.local_id
    WHERE b.control_store_id=control AND b.local_id=wanted_local AND b.archive_id=wanted_archive
      AND m.purge_receipt IS NULL
      AND encode(sha256(convert_to(a.payload,'UTF8')),'hex')=b.payload_sha256
      AND a.payload::jsonb->>'id'=b.archive_id AND a.payload::jsonb->>'workspace'=b.local_id
      AND a.payload::jsonb->>'sha256'=b.ciphertext_sha256;
  IF result IS NULL THEN RAISE EXCEPTION 'ORBITA_PG_MANAGED_ARCHIVE_BINDING'; END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION orbita_common.managed_legacy_archive(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orbita_common.managed_legacy_archive(text,text) TO orbita_runtime;
