-- Validate the whole declared initialization set before binding any member.
-- This is a metadata operation, never permission to execute arbitrary DDL.
CREATE OR REPLACE FUNCTION orbita_common.ensure_definitions(wanted_names text[],wanted_hashes text[])
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE store uuid; wanted_family text; matches bigint; changed bigint; total integer;
BEGIN
  store=orbita_common.store_id();
  IF store IS NULL THEN RAISE EXCEPTION 'ORBITA_PG_STORE_NOT_BOUND' USING ERRCODE='28000'; END IF;
  IF NOT orbita_common.can_write() THEN RAISE EXCEPTION 'ORBITA_PG_READ_ONLY' USING ERRCODE='25006'; END IF;
  total=cardinality(wanted_names);
  IF total IS NULL OR total<1 OR total>512 OR cardinality(wanted_hashes) IS DISTINCT FROM total
    THEN RAISE EXCEPTION 'ORBITA_PG_DEFINITION_BATCH' USING ERRCODE='22023'; END IF;
  SELECT family INTO STRICT wanted_family FROM orbita_private.stores WHERE id=store;
  SELECT count(*) INTO matches FROM unnest(wanted_names,wanted_hashes) AS d(name,digest)
    JOIN orbita_private.schema_catalog c ON c.family=wanted_family AND c.name=d.name AND c.source_hash=d.digest;
  IF matches<>total THEN RAISE EXCEPTION 'ORBITA_PG_UNKNOWN_DEFINITION' USING ERRCODE='22023'; END IF;
  INSERT INTO orbita_private.store_catalog(store_id,name,kind,source_sql)
    SELECT store,c.name,c.kind,c.source_sql FROM orbita_private.schema_catalog c
      WHERE c.family=wanted_family AND c.name=ANY(wanted_names)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed;
END $$;
REVOKE ALL ON FUNCTION orbita_common.ensure_definitions(text[],text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orbita_common.ensure_definitions(text[],text[]) TO orbita_runtime;
