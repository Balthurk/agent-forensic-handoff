-- Typed content transfers create a new logical store atomically. Neither the
-- archive nor a caller can execute DDL, replace an existing store, or restore
-- workspace capabilities and other private control-plane state.
CREATE OR REPLACE FUNCTION orbita_common.describe_store(wanted_path text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;
BEGIN
  IF orbita_common.workspace_id() IS NULL THEN RAISE EXCEPTION 'ORBITA_PG_ACCESS_DENIED' USING ERRCODE='28000'; END IF;
  SELECT jsonb_build_object('family',s.family,'storeId',s.id) INTO result
    FROM orbita_private.stores s JOIN orbita_common.entries e ON e.workspace_id=s.workspace_id AND e.store_id=s.id
    WHERE s.workspace_id=orbita_common.workspace_id() AND e.path=wanted_path AND e.kind='store';
  IF result IS NULL THEN RAISE EXCEPTION 'ORBITA_PG_STORE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION orbita_common.transfer_structure() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE shape jsonb;
BEGIN
  shape=orbita_common.store_structure();
  RETURN jsonb_build_object('shape',shape,'order',(SELECT jsonb_agg(table_name ORDER BY copy_order)
    FROM orbita_private.ordered_tables(shape->>'family')));
END $$;

CREATE OR REPLACE FUNCTION orbita_common.begin_store_import(wanted_path text,wanted_family text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE workspace uuid; store uuid; started timestamptz;
BEGIN
  workspace=orbita_common.workspace_id();
  IF workspace IS NULL OR NOT orbita_common.can_write() THEN RAISE EXCEPTION 'ORBITA_PG_READ_ONLY' USING ERRCODE='25006'; END IF;
  IF current_setting('transaction_isolation') NOT IN ('repeatable read','serializable') THEN
    RAISE EXCEPTION 'ORBITA_PG_IMPORT_SNAPSHOT_REQUIRED'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('names:' || workspace::text,0));
  IF EXISTS(SELECT 1 FROM orbita_common.entries WHERE workspace_id=workspace AND path=wanted_path)
    OR EXISTS(SELECT 1 FROM orbita_private.stores WHERE workspace_id=workspace AND logical_key=wanted_path)
    THEN RAISE EXCEPTION 'ORBITA_PG_IMPORT_DESTINATION_EXISTS' USING ERRCODE='23505'; END IF;
  store=orbita_common.open_store(wanted_path,wanted_family,true);
  SELECT backend_start INTO STRICT started FROM pg_catalog.pg_stat_get_activity(pg_backend_pid());
  -- This narrowly permits preservation of internal vector insertion ordinals.
  -- The store did not exist before this transaction; no existing rows can be
  -- changed through this authority, and rollback removes the authority too.
  INSERT INTO orbita_private.tree_operations VALUES(pg_backend_pid(),started,txid_current(),store,'clone');
  RETURN store;
END $$;

CREATE OR REPLACE FUNCTION orbita_common.finish_store_import(catalogue jsonb,counters jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE store uuid; family_name text; entry record; item jsonb; started timestamptz; counter_value bigint;
BEGIN
  store=orbita_common.store_id();
  IF store IS NULL OR NOT orbita_common.can_write() OR NOT orbita_private.tree_authorized(store,'clone') THEN
    RAISE EXCEPTION 'ORBITA_PG_IMPORT_AUTHORITY' USING ERRCODE='42501'; END IF;
  SELECT family INTO STRICT family_name FROM orbita_private.stores WHERE id=store AND workspace_id=orbita_common.workspace_id();
  IF jsonb_typeof(catalogue) IS DISTINCT FROM 'array' OR jsonb_typeof(counters) IS DISTINCT FROM 'object'
    OR jsonb_array_length(catalogue)>512 OR octet_length(catalogue::text)+octet_length(counters::text)>1048576
    THEN RAISE EXCEPTION 'ORBITA_PG_IMPORT_METADATA'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(catalogue)) <>
     (SELECT count(DISTINCT x->>'name') FROM jsonb_array_elements(catalogue) x) THEN
    RAISE EXCEPTION 'ORBITA_PG_IMPORT_CATALOGUE'; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(catalogue) LOOP
    IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item) key) IS DISTINCT FROM ARRAY['kind','name','source']::text[]
      OR NOT EXISTS(SELECT 1 FROM orbita_private.schema_catalog c WHERE c.family=family_name AND c.name=item->>'name'
        AND c.kind=item->>'kind' AND c.source_sql=item->>'source') THEN
      RAISE EXCEPTION 'ORBITA_PG_IMPORT_CATALOGUE'; END IF;
    INSERT INTO orbita_private.store_catalog(store_id,name,kind,source_sql)
      VALUES(store,item->>'name',item->>'kind',item->>'source');
  END LOOP;
  FOR entry IN SELECT key,val FROM jsonb_each(counters) AS c(key,val) LOOP
    IF jsonb_typeof(entry.val)<>'number' OR entry.val::text !~ '^(0|[1-9][0-9]{0,18})$'
      OR NOT (EXISTS(SELECT 1 FROM orbita_private.schema_catalog c WHERE c.family=family_name AND c.kind='table'
        AND family_name || '.' || c.name=entry.key) OR family_name='vector' AND entry.key='vector._index_ordinal') THEN
      RAISE EXCEPTION 'ORBITA_PG_IMPORT_COUNTER'; END IF;
    counter_value=(entry.val::text)::bigint;
    IF EXISTS(SELECT 1 FROM orbita_private.row_counters c WHERE c.store_id=store AND c.relation_name=entry.key AND c.value>counter_value) THEN
      RAISE EXCEPTION 'ORBITA_PG_IMPORT_COUNTER_REGRESSION'; END IF;
    INSERT INTO orbita_private.row_counters(store_id,relation_name,value) VALUES(store,entry.key,counter_value)
      ON CONFLICT ON CONSTRAINT row_counters_pkey DO UPDATE SET value=excluded.value;
  END LOOP;
  IF EXISTS(SELECT 1 FROM orbita_private.row_counters c WHERE c.store_id=store AND NOT (counters ? c.relation_name)) THEN
    RAISE EXCEPTION 'ORBITA_PG_IMPORT_COUNTER_MISSING'; END IF;
  SELECT backend_start INTO STRICT started FROM pg_catalog.pg_stat_get_activity(pg_backend_pid());
  DELETE FROM orbita_private.tree_operations WHERE pid=pg_backend_pid() AND backend_start=started
    AND transaction_id=txid_current() AND store_id=store AND operation='clone';
END $$;

REVOKE ALL ON FUNCTION orbita_common.describe_store(text),orbita_common.transfer_structure(),
  orbita_common.begin_store_import(text,text),orbita_common.finish_store_import(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orbita_common.describe_store(text),orbita_common.transfer_structure(),
  orbita_common.begin_store_import(text,text),orbita_common.finish_store_import(jsonb,jsonb) TO orbita_runtime;
