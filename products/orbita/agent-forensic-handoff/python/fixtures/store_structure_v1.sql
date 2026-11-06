-- Describe only the currently authorized logical store and its actual schema.
CREATE OR REPLACE FUNCTION orbita_common.store_structure() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_store uuid; family_name text; rel record; actual regclass; tables jsonb='[]'; shape jsonb;
BEGIN
  current_store=orbita_common.store_id();
  IF current_store IS NULL THEN RAISE EXCEPTION 'ORBITA_PG_STORE_NOT_BOUND' USING ERRCODE='28000'; END IF;
  SELECT family INTO STRICT family_name FROM orbita_private.stores WHERE id=current_store AND workspace_id=orbita_common.workspace_id();
  FOR rel IN SELECT name,source_hash FROM orbita_private.schema_catalog WHERE family=family_name AND kind='table' ORDER BY name COLLATE "C" LOOP
    actual=to_regclass(format('%I.%I','orbita_' || family_name,rel.name));
    IF actual IS NULL OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=actual AND relrowsecurity AND relforcerowsecurity)
      THEN RAISE EXCEPTION 'ORBITA_PG_RELATION_SCOPE_INVALID'; END IF;
    IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=actual AND NOT convalidated)
      OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=actual AND contype='p')
      OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=actual AND tgname='orbita_assign_rowid' AND tgenabled IN ('O','A'))
      OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=actual AND tgname='orbita_remember_insert' AND tgenabled IN ('O','A'))
      OR EXISTS(SELECT 1 FROM orbita_private.schema_catalog c WHERE c.family=family_name AND c.kind='trigger'
        AND c.definition->>'table'=rel.name AND NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=actual AND t.tgname=c.name AND t.tgenabled IN ('O','A')))
      THEN RAISE EXCEPTION 'ORBITA_PG_RELATION_CONSTRAINT_INVALID'; END IF;
    SELECT jsonb_build_object('name',rel.name,'sourceHash',rel.source_hash,
      'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'generated',a.attgenerated,'notNull',a.attnotnull) ORDER BY a.attnum)
        FROM pg_attribute a WHERE a.attrelid=actual AND a.attnum>0 AND NOT a.attisdropped AND a.attname<>'_store_id'),
      'constraints',(SELECT jsonb_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid) COLLATE "C") FROM pg_constraint WHERE conrelid=actual),
      'triggers',(SELECT jsonb_agg(jsonb_build_object('name',tgname,'enabled',tgenabled,'definition',pg_get_triggerdef(oid)) ORDER BY tgname COLLATE "C") FROM pg_trigger WHERE tgrelid=actual AND NOT tgisinternal)) INTO shape;
    tables=tables || jsonb_build_array(shape);
  END LOOP;
  RETURN jsonb_build_object('family',family_name,'tables',tables,
    'catalogue',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',name,'kind',kind,'source',source_sql) ORDER BY name COLLATE "C"),'[]') FROM orbita_private.store_catalog WHERE store_id=current_store),
    'counters',(SELECT coalesce(jsonb_object_agg(relation_name,value),'{}') FROM orbita_private.row_counters WHERE store_id=current_store));
END $$;
REVOKE ALL ON FUNCTION orbita_common.store_structure() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orbita_common.store_structure() TO orbita_runtime;
