-- Fresh actual catalogue structure, gathered together without a metadata cache.
CREATE OR REPLACE FUNCTION orbita_common.store_structure() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_store uuid; family_name text; tables jsonb; invalid text;
BEGIN
  current_store=orbita_common.store_id();
  IF current_store IS NULL THEN RAISE EXCEPTION 'ORBITA_PG_STORE_NOT_BOUND' USING ERRCODE='28000'; END IF;
  SELECT family INTO STRICT family_name FROM orbita_private.stores WHERE id=current_store AND workspace_id=orbita_common.workspace_id();
  WITH relations AS MATERIALIZED (
    SELECT c.name,c.source_hash,r.oid,r.relrowsecurity,r.relforcerowsecurity
    FROM orbita_private.schema_catalog c
    LEFT JOIN pg_namespace n ON n.nspname='orbita_'||family_name
    LEFT JOIN pg_class r ON r.relnamespace=n.oid AND r.relname=c.name
    WHERE c.family=family_name AND c.kind='table'
  ), columns AS (
    SELECT a.attrelid,jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
      'generated',a.attgenerated,'notNull',a.attnotnull) ORDER BY a.attnum) AS shape
    FROM pg_attribute a JOIN relations r ON r.oid=a.attrelid
    WHERE a.attnum>0 AND NOT a.attisdropped AND a.attname<>'_store_id' GROUP BY a.attrelid
  ), constraints AS (
    SELECT c.conrelid,bool_or(NOT c.convalidated) AS invalid,bool_or(c.contype='p') AS has_primary,
      jsonb_agg(pg_get_constraintdef(c.oid) ORDER BY pg_get_constraintdef(c.oid) COLLATE "C") AS shape
    FROM pg_constraint c JOIN relations r ON r.oid=c.conrelid GROUP BY c.conrelid
  ), triggers AS (
    SELECT t.tgrelid,bool_or(t.tgname='orbita_assign_rowid' AND t.tgenabled IN ('O','A')) AS has_assign,
      bool_or(t.tgname='orbita_remember_insert' AND t.tgenabled IN ('O','A')) AS has_remember,
      jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid))
        ORDER BY t.tgname COLLATE "C") FILTER (WHERE NOT t.tgisinternal) AS shape
    FROM pg_trigger t JOIN relations r ON r.oid=t.tgrelid GROUP BY t.tgrelid
  ), checked AS (
    SELECT r.name,
      CASE WHEN r.oid IS NULL OR NOT r.relrowsecurity OR NOT r.relforcerowsecurity
        THEN 'ORBITA_PG_RELATION_SCOPE_INVALID'
      WHEN coalesce(c.invalid,false) OR NOT coalesce(c.has_primary,false)
        OR NOT coalesce(t.has_assign,false) OR NOT coalesce(t.has_remember,false)
        OR EXISTS(SELECT 1 FROM orbita_private.schema_catalog d WHERE d.family=family_name AND d.kind='trigger'
          AND d.definition->>'table'=r.name AND NOT EXISTS(SELECT 1 FROM pg_trigger g
            WHERE g.tgrelid=r.oid AND g.tgname=d.name AND g.tgenabled IN ('O','A')))
        THEN 'ORBITA_PG_RELATION_CONSTRAINT_INVALID' END AS error,
      jsonb_build_object('name',r.name,'sourceHash',r.source_hash,'columns',a.shape,'constraints',c.shape,'triggers',t.shape) AS shape
    FROM relations r LEFT JOIN columns a ON a.attrelid=r.oid
    LEFT JOIN constraints c ON c.conrelid=r.oid LEFT JOIN triggers t ON t.tgrelid=r.oid
  )
  SELECT coalesce(jsonb_agg(shape ORDER BY name COLLATE "C"),'[]'),
    (array_agg(error ORDER BY name COLLATE "C") FILTER (WHERE error IS NOT NULL))[1]
    INTO tables,invalid FROM checked;
  IF invalid IS NOT NULL THEN RAISE EXCEPTION '%',invalid; END IF;
  RETURN jsonb_build_object('family',family_name,'tables',tables,
    'catalogue',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',name,'kind',kind,'source',source_sql) ORDER BY name COLLATE "C"),'[]') FROM orbita_private.store_catalog WHERE store_id=current_store),
    'counters',(SELECT coalesce(jsonb_object_agg(relation_name,value),'{}') FROM orbita_private.row_counters WHERE store_id=current_store));
END $$;
REVOKE ALL ON FUNCTION orbita_common.store_structure() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orbita_common.store_structure() TO orbita_runtime;
