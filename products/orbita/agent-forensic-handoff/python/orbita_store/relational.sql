-- Server-side invariants for shared family tables. Installed by the operator.
ALTER TABLE orbita_private.sessions ADD COLUMN IF NOT EXISTS insert_serial bigint NOT NULL DEFAULT 0;
ALTER TABLE orbita_private.sessions ADD COLUMN IF NOT EXISTS last_insert_rowid bigint;
CREATE OR REPLACE FUNCTION orbita_common.insert_status() RETURNS TABLE(serial bigint,rowid bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  -- Every read still resolves the exact backend and current authority fences.
  SELECT COALESCE(e.serial,0),e.last_insert_rowid
  FROM orbita_private.visible_session() s
  LEFT JOIN LATERAL (
    SELECT i.serial,i.last_insert_rowid FROM orbita_private.insert_events i
    WHERE i.pid=s.pid AND i.backend_start=s.backend_start ORDER BY i.serial DESC LIMIT 1
  ) e ON true
$$;
CREATE OR REPLACE FUNCTION orbita_common.remember_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  INSERT INTO orbita_private.insert_events(pid,backend_start,serial,last_insert_rowid)
    SELECT s.pid,s.backend_start,COALESCE((
      SELECT i.serial FROM orbita_private.insert_events i
      WHERE i.pid=s.pid AND i.backend_start=s.backend_start ORDER BY i.serial DESC LIMIT 1
    ),0)+1,NEW.rowid
    FROM orbita_private.sessions s
    WHERE s.pid=pg_backend_pid() AND s.store_id=NEW._store_id
      AND s.backend_start=(SELECT backend_start FROM pg_catalog.pg_stat_get_activity(pg_backend_pid()));
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION orbita_common.ascii_fold(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog AS $$
  SELECT translate(value,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')
$$;

CREATE OR REPLACE FUNCTION orbita_common.assign_rowid() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE field text; relation text; wanted bigint; authorized orbita_private.sessions%ROWTYPE;
BEGIN
  SELECT s.* INTO authorized FROM orbita_private.visible_session() s;
  IF NOT FOUND OR authorized.store_id IS NULL OR NEW._store_id IS DISTINCT FROM authorized.store_id
      OR COALESCE(authorized.read_only,true)
    THEN RAISE EXCEPTION 'ORBITA_PG_STORE_WRITE_DENIED' USING ERRCODE='42501'; END IF;
  field=TG_ARGV[0]; relation=TG_ARGV[1];
  wanted=(to_jsonb(NEW)->>field)::bigint;
  -- Allocation remains transactional and monotonic per logical table.
  -- A generated ordinal updates the counter once; explicit ordinals only
  -- advance it, without rewriting an unchanged counter on every UPDATE.
  IF wanted IS NULL THEN
    INSERT INTO orbita_private.row_counters(store_id,relation_name,value)
      VALUES(authorized.store_id,relation,1)
      ON CONFLICT ON CONSTRAINT row_counters_pkey DO UPDATE
      SET value=orbita_private.row_counters.value+1 RETURNING value INTO wanted;
  ELSE
    INSERT INTO orbita_private.row_counters(store_id,relation_name,value)
      VALUES(authorized.store_id,relation,GREATEST(wanted,0))
      ON CONFLICT ON CONSTRAINT row_counters_pkey DO UPDATE SET value=excluded.value
      WHERE orbita_private.row_counters.value<excluded.value;
  END IF;
  NEW=jsonb_populate_record(NEW,jsonb_build_object(field,wanted));
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION orbita_common.ascii_fold(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION orbita_common.assign_rowid() FROM PUBLIC;
REVOKE ALL ON FUNCTION orbita_common.remember_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION orbita_common.insert_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orbita_common.ascii_fold(text) TO orbita_runtime;
GRANT EXECUTE ON FUNCTION orbita_common.insert_status() TO orbita_runtime;

CREATE OR REPLACE FUNCTION orbita_common.assign_vector_ordinal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW._store_id IS DISTINCT FROM orbita_common.store_id() OR NOT orbita_common.can_write()
    THEN RAISE EXCEPTION 'ORBITA_PG_STORE_WRITE_DENIED' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW._index_ordinal IS DISTINCT FROM OLD._index_ordinal
      THEN RAISE EXCEPTION 'ORBITA_PG_VECTOR_ORDER_IMMUTABLE' USING ERRCODE='23514'; END IF;
  ELSE
    IF orbita_private.tree_authorized(NEW._store_id,'clone') THEN
      IF NEW._index_ordinal IS NULL OR NEW._index_ordinal<1 THEN RAISE EXCEPTION 'ORBITA_PG_VECTOR_ORDER_PROVENANCE_REQUIRED' USING ERRCODE='23514'; END IF;
    ELSE
      IF NEW._index_ordinal IS NOT NULL THEN RAISE EXCEPTION 'ORBITA_PG_VECTOR_ORDER_RESERVED' USING ERRCODE='23514'; END IF;
      NEW._index_ordinal=orbita_common.next_rowid('vector._index_ordinal');
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION orbita_common.assign_vector_ordinal() FROM PUBLIC;
