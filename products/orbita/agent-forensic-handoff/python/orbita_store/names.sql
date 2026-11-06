-- Logical store locations share the object namespace. Moving a directory
-- changes locators atomically; existing readers keep the immutable store UUID.
CREATE UNIQUE INDEX IF NOT EXISTS store_locator_identity
  ON orbita_common.entries(workspace_id,store_id) WHERE store_id IS NOT NULL;

CREATE OR REPLACE FUNCTION orbita_common.open_store(wanted_key text,wanted_family text,create_missing boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE workspace uuid; store_uuid uuid; existing_family text; parent text=''; component text; parts text[]; existing_kind text;
BEGIN
  workspace=orbita_common.workspace_id();
  IF workspace IS NULL THEN RAISE EXCEPTION 'ORBITA_PG_ACCESS_DENIED' USING ERRCODE='28000'; END IF;
  IF wanted_key IS NULL OR length(wanted_key) NOT BETWEEN 1 AND 4096
    OR wanted_key ~ '(^/|/$|//|(^|/)\.{1,2}(/|$)|\\|:|[[:cntrl:]])'
    OR NOT EXISTS(SELECT 1 FROM orbita_private.families WHERE name=wanted_family)
    THEN RAISE EXCEPTION 'ORBITA_PG_INVALID_STORE_KEY' USING ERRCODE='22023'; END IF;
  IF create_missing THEN
    IF NOT orbita_common.can_write() THEN RAISE EXCEPTION 'ORBITA_PG_READ_ONLY' USING ERRCODE='25006'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('names:' || workspace::text,0));
    INSERT INTO orbita_private.stores(workspace_id,logical_key,family)
      VALUES(workspace,wanted_key,wanted_family) ON CONFLICT(workspace_id,logical_key) DO NOTHING;
  ELSE
    -- Serialize a new reader binding with a concurrent exact tree purge.
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('names:' || workspace::text,0));
  END IF;
  SELECT id,family INTO store_uuid,existing_family FROM orbita_private.stores
    WHERE workspace_id=workspace AND logical_key=wanted_key;
  IF store_uuid IS NULL THEN RAISE EXCEPTION 'ORBITA_PG_STORE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF existing_family<>wanted_family THEN RAISE EXCEPTION 'ORBITA_PG_STORE_FAMILY_CHANGED' USING ERRCODE='22023'; END IF;
  IF create_missing THEN
    INSERT INTO orbita_common.entries(workspace_id,path,kind) VALUES(workspace,'','directory') ON CONFLICT DO NOTHING;
    parts=string_to_array(wanted_key,'/');
    IF cardinality(parts)>1 THEN
      FOREACH component IN ARRAY parts[1:cardinality(parts)-1] LOOP
        parent=CASE WHEN parent='' THEN component ELSE parent || '/' || component END;
        SELECT kind INTO existing_kind FROM orbita_common.entries WHERE workspace_id=workspace AND path=parent;
        IF FOUND AND existing_kind<>'directory' THEN RAISE EXCEPTION 'ORBITA_PG_NOT_DIRECTORY'; END IF;
        INSERT INTO orbita_common.entries(workspace_id,path,kind) VALUES(workspace,parent,'directory') ON CONFLICT DO NOTHING;
      END LOOP;
    END IF;
    INSERT INTO orbita_common.entries(workspace_id,path,kind,store_id) VALUES(workspace,wanted_key,'store',store_uuid) ON CONFLICT(workspace_id,path) DO NOTHING;
    IF NOT EXISTS(SELECT 1 FROM orbita_common.entries WHERE workspace_id=workspace AND path=wanted_key AND kind='store' AND store_id=store_uuid) THEN
      RAISE EXCEPTION 'ORBITA_PG_LOCATOR_CONFLICT'; END IF;
  END IF;
  UPDATE orbita_private.sessions SET store_id=store_uuid WHERE pid=pg_backend_pid()
    AND backend_start=(SELECT backend_start FROM pg_catalog.pg_stat_get_activity(pg_backend_pid()));
  RETURN store_uuid;
END $$;

CREATE OR REPLACE FUNCTION orbita_common.rename_tree(source text,target text,replace_existing boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE workspace uuid; original orbita_common.entries%ROWTYPE; destination orbita_common.entries%ROWTYPE; parent text; retired uuid;
BEGIN
  workspace=orbita_common.workspace_id();
  IF workspace IS NULL OR NOT orbita_common.can_write() THEN RAISE EXCEPTION 'ORBITA_PG_READ_ONLY' USING ERRCODE='25006'; END IF;
  IF source IS NULL OR target IS NULL OR length(source) NOT BETWEEN 1 AND 4096 OR length(target) NOT BETWEEN 1 AND 4096
    OR source ~ '(^/|/$|//|(^|/)\.{1,2}(/|$)|\\|:|[[:cntrl:]])'
    OR target ~ '(^/|/$|//|(^|/)\.{1,2}(/|$)|\\|:|[[:cntrl:]])'
    THEN RAISE EXCEPTION 'ORBITA_PG_INVALID_NAME' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('names:' || workspace::text,0));
  SELECT * INTO original FROM orbita_common.entries WHERE workspace_id=workspace AND path=source;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORBITA_PG_NAME_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF source=target THEN RETURN; END IF;
  IF starts_with(target,source || '/') THEN RAISE EXCEPTION 'ORBITA_PG_RENAME_INTO_SELF'; END IF;
  parent=CASE WHEN strpos(target,'/')=0 THEN '' ELSE regexp_replace(target,'/[^/]*$','') END;
  IF NOT EXISTS(SELECT 1 FROM orbita_common.entries WHERE workspace_id=workspace AND path=parent AND kind='directory') THEN
    RAISE EXCEPTION 'ORBITA_PG_PARENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO destination FROM orbita_common.entries WHERE workspace_id=workspace AND path=target;
  IF FOUND THEN
    IF NOT replace_existing THEN RAISE EXCEPTION 'ORBITA_PG_DESTINATION_EXISTS' USING ERRCODE='23505'; END IF;
    IF destination.kind<>original.kind THEN RAISE EXCEPTION 'ORBITA_PG_NAME_KIND_CONFLICT'; END IF;
    IF destination.kind='store' THEN RAISE EXCEPTION 'ORBITA_PG_STORE_REPLACEMENT_REQUIRES_RESTORE'; END IF;
    IF destination.kind='directory' AND EXISTS(SELECT 1 FROM orbita_common.entries WHERE workspace_id=workspace AND starts_with(path,target || '/')) THEN
      RAISE EXCEPTION 'ORBITA_PG_DIRECTORY_NOT_EMPTY'; END IF;
    retired=destination.object_id;
    DELETE FROM orbita_common.entries WHERE workspace_id=workspace AND path=target;
  END IF;
  UPDATE orbita_private.stores SET logical_key=target || substring(logical_key from length(source)+1),revision=revision+1
    WHERE workspace_id=workspace AND (logical_key=source OR starts_with(logical_key,source || '/'));
  UPDATE orbita_common.entries SET path=target || substring(path from length(source)+1),revision=revision+1,modified_at=clock_timestamp()
    WHERE workspace_id=workspace AND (path=source OR starts_with(path,source || '/'));
  IF retired IS NOT NULL THEN PERFORM orbita_private.collect_objects_in_workspace(workspace,ARRAY[retired]); END IF;
END $$;
REVOKE ALL ON FUNCTION orbita_common.open_store(text,text,boolean),orbita_common.rename_tree(text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orbita_common.open_store(text,text,boolean),orbita_common.rename_tree(text,text,boolean) TO orbita_runtime;
