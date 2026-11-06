-- Exact logical trees. Privileged routines never accept SQL or workspace IDs.
-- Private operation authority exists only in this backend and transaction.
CREATE TABLE IF NOT EXISTS orbita_private.tree_operations (
  pid integer NOT NULL, backend_start timestamptz NOT NULL, transaction_id bigint NOT NULL,
  store_id uuid NOT NULL, operation text NOT NULL CHECK(operation IN ('clone','purge')),
  PRIMARY KEY(pid,backend_start,transaction_id,store_id)
);
CREATE TABLE IF NOT EXISTS orbita_private.writer_paths (
  pin_id uuid PRIMARY KEY REFERENCES orbita_private.object_pins(id) ON DELETE CASCADE,
  path text NOT NULL
);
REVOKE ALL ON orbita_private.tree_operations,orbita_private.writer_paths FROM PUBLIC,orbita_runtime;

CREATE OR REPLACE FUNCTION orbita_private.tree_authorized(wanted uuid,action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM orbita_private.tree_operations o
    WHERE o.pid=pg_backend_pid() AND o.transaction_id=txid_current()
      AND o.backend_start=(SELECT backend_start FROM pg_catalog.pg_stat_get_activity(pg_backend_pid()))
      AND o.store_id=wanted AND o.operation=action)
$$;
CREATE OR REPLACE FUNCTION orbita_common.reject_row_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' AND orbita_private.tree_authorized(OLD._store_id,'purge') THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'append only' USING ERRCODE='23514';
END $$;

CREATE OR REPLACE FUNCTION orbita_common.register_writer(wanted_pin uuid,wanted_path text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NOT orbita_common.can_write() OR wanted_path IS NULL OR length(wanted_path) NOT BETWEEN 1 AND 4096
    OR wanted_path ~ '(^/|/$|//|(^|/)\.{1,2}(/|$)|\\|:|[[:cntrl:]])'
    OR NOT EXISTS(SELECT 1 FROM orbita_private.object_pins p JOIN orbita_common.objects o
      ON o.workspace_id=p.workspace_id AND o.id=p.object_id
      WHERE p.id=wanted_pin AND p.workspace_id=orbita_common.workspace_id() AND NOT o.complete
        AND p.pid=pg_backend_pid() AND p.backend_start=(SELECT backend_start FROM pg_catalog.pg_stat_get_activity(pg_backend_pid())))
    THEN RAISE EXCEPTION 'ORBITA_PG_WRITER_AUTHORITY' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('names:' || orbita_common.workspace_id()::text,0));
  INSERT INTO orbita_private.writer_paths(pin_id,path) VALUES(wanted_pin,wanted_path);
END $$;

CREATE OR REPLACE FUNCTION orbita_private.ordered_tables(wanted_family text)
RETURNS TABLE(table_name text,copy_order integer) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pending text[]; done text[]='{}'; chosen text; relation oid;
BEGIN
  SELECT array_agg(name ORDER BY name) INTO pending FROM orbita_private.schema_catalog
    WHERE family=wanted_family AND kind='table';
  WHILE cardinality(pending)>0 LOOP
    chosen=NULL;
    FOREACH table_name IN ARRAY pending LOOP
      relation=to_regclass(format('%I.%I','orbita_' || wanted_family,table_name));
      IF relation IS NULL THEN RAISE EXCEPTION 'ORBITA_PG_CATALOGUE_TABLE_MISSING'; END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_class parent ON parent.oid=c.confrelid
        JOIN pg_namespace ns ON ns.oid=parent.relnamespace WHERE c.conrelid=relation AND c.contype='f'
          AND c.confrelid<>relation AND (ns.nspname<>'orbita_' || wanted_family OR NOT parent.relname=ANY(done)))
        THEN chosen=table_name; EXIT; END IF;
    END LOOP;
    IF chosen IS NULL THEN RAISE EXCEPTION 'ORBITA_PG_TREE_FOREIGN_KEY_CYCLE'; END IF;
    done=array_append(done,chosen);pending=array_remove(pending,chosen);
    table_name=chosen;copy_order=cardinality(done);RETURN NEXT;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION orbita_common.purge_tree(wanted_path text,recursive boolean,missing_ok boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE workspace uuid; root_kind text; item record; rel record; retired uuid[]; stores_count integer=0;
  entries_count bigint; rows_count bigint=0; affected bigint; started timestamptz;
BEGIN
  workspace=orbita_common.workspace_id();
  IF workspace IS NULL OR NOT orbita_common.can_write() THEN RAISE EXCEPTION 'ORBITA_PG_READ_ONLY' USING ERRCODE='25006'; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ORBITA_PG_PURGE_FRESH_AUTHORITY_REQUIRED'; END IF;
  IF wanted_path IS NULL OR length(wanted_path) NOT BETWEEN 1 AND 4096
    OR wanted_path ~ '(^/|/$|//|(^|/)\.{1,2}(/|$)|\\|:|[[:cntrl:]])'
    THEN RAISE EXCEPTION 'ORBITA_PG_ROOT_OR_INVALID_PURGE'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('names:' || workspace::text,0));
  SELECT kind INTO root_kind FROM orbita_common.entries WHERE workspace_id=workspace AND path=wanted_path;
  IF NOT FOUND THEN
    IF missing_ok THEN RETURN jsonb_build_object('entries',0,'stores',0,'rows',0); END IF;
    RAISE EXCEPTION 'ORBITA_PG_NAME_NOT_FOUND' USING ERRCODE='P0002';
  END IF;
  IF root_kind='directory' AND NOT recursive THEN RAISE EXCEPTION 'ORBITA_PG_RECURSIVE_REQUIRED'; END IF;
  IF EXISTS(SELECT 1 FROM orbita_private.writer_paths w JOIN orbita_private.object_pins p ON p.id=w.pin_id
    JOIN pg_stat_activity a ON a.pid=p.pid AND a.backend_start=p.backend_start
    WHERE p.workspace_id=workspace AND (w.path=wanted_path OR starts_with(w.path,wanted_path || '/')))
    THEN RAISE EXCEPTION 'ORBITA_PG_TREE_HAS_LIVE_WRITER' USING ERRCODE='55006'; END IF;
  IF EXISTS(SELECT 1 FROM orbita_private.sessions s JOIN orbita_private.stores t ON t.id=s.store_id
    JOIN pg_stat_activity a ON a.pid=s.pid AND a.backend_start=s.backend_start
    WHERE t.workspace_id=workspace AND (t.logical_key=wanted_path OR starts_with(t.logical_key,wanted_path || '/')))
    THEN RAISE EXCEPTION 'ORBITA_PG_TREE_HAS_OPEN_STORE' USING ERRCODE='55006'; END IF;
  SELECT backend_start INTO STRICT started FROM pg_catalog.pg_stat_get_activity(pg_backend_pid());
  SELECT array_agg(DISTINCT object_id) FILTER(WHERE object_id IS NOT NULL),count(*) INTO retired,entries_count
    FROM orbita_common.entries WHERE workspace_id=workspace AND (path=wanted_path OR starts_with(path,wanted_path || '/'));
  FOR item IN SELECT * FROM orbita_private.stores WHERE workspace_id=workspace
    AND (logical_key=wanted_path OR starts_with(logical_key,wanted_path || '/')) ORDER BY id LOOP
    INSERT INTO orbita_private.tree_operations VALUES(pg_backend_pid(),started,txid_current(),item.id,'purge');
    FOR rel IN SELECT * FROM orbita_private.ordered_tables(item.family) ORDER BY copy_order DESC LOOP
      EXECUTE format('DELETE FROM %I.%I WHERE _store_id=$1','orbita_' || item.family,rel.table_name) USING item.id;
      GET DIAGNOSTICS affected=ROW_COUNT;rows_count=rows_count+affected;
    END LOOP;
    DELETE FROM orbita_private.tree_operations WHERE pid=pg_backend_pid() AND backend_start=started
      AND transaction_id=txid_current() AND store_id=item.id;
    DELETE FROM orbita_private.sessions WHERE store_id=item.id;
    DELETE FROM orbita_private.row_counters WHERE store_id=item.id;
    DELETE FROM orbita_private.store_catalog WHERE store_id=item.id;
    DELETE FROM orbita_common.entries WHERE workspace_id=workspace AND store_id=item.id;
    DELETE FROM orbita_private.stores WHERE id=item.id AND workspace_id=workspace;
    stores_count=stores_count+1;
  END LOOP;
  DELETE FROM orbita_common.entries WHERE workspace_id=workspace AND (path=wanted_path OR starts_with(path,wanted_path || '/'));
  IF retired IS NOT NULL THEN PERFORM orbita_private.collect_objects_in_workspace(workspace,retired); END IF;
  RETURN jsonb_build_object('entries',entries_count,'stores',stores_count,'rows',rows_count);
END $$;

CREATE OR REPLACE FUNCTION orbita_common.clone_tree(source text,target text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE workspace uuid; parent text; item record; rel record; original record; new_id uuid; saved_store uuid;
  fields text; started timestamptz; entries_count bigint; stores_count integer=0; rows_count bigint=0; affected bigint;
BEGIN
  workspace=orbita_common.workspace_id();
  IF workspace IS NULL OR NOT orbita_common.can_write() THEN RAISE EXCEPTION 'ORBITA_PG_READ_ONLY' USING ERRCODE='25006'; END IF;
  IF current_setting('transaction_isolation') NOT IN ('repeatable read','serializable') THEN
    RAISE EXCEPTION 'ORBITA_PG_CLONE_SNAPSHOT_REQUIRED'; END IF;
  IF source IS NULL OR target IS NULL OR length(source) NOT BETWEEN 1 AND 4096 OR length(target) NOT BETWEEN 1 AND 4096
    OR source ~ '(^/|/$|//|(^|/)\.{1,2}(/|$)|\\|:|[[:cntrl:]])'
    OR target ~ '(^/|/$|//|(^|/)\.{1,2}(/|$)|\\|:|[[:cntrl:]])'
    OR source=target OR starts_with(target,source || '/') OR starts_with(source,target || '/')
    THEN RAISE EXCEPTION 'ORBITA_PG_ROOT_OR_INVALID_CLONE'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('names:' || workspace::text,0));
  IF NOT EXISTS(SELECT 1 FROM orbita_common.entries WHERE workspace_id=workspace AND path=source) THEN
    RAISE EXCEPTION 'ORBITA_PG_NAME_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF EXISTS(SELECT 1 FROM orbita_common.entries WHERE workspace_id=workspace AND path=target) THEN
    RAISE EXCEPTION 'ORBITA_PG_DESTINATION_EXISTS' USING ERRCODE='23505'; END IF;
  parent=CASE WHEN strpos(target,'/')=0 THEN '' ELSE regexp_replace(target,'/[^/]*$','') END;
  IF NOT EXISTS(SELECT 1 FROM orbita_common.entries WHERE workspace_id=workspace AND path=parent AND kind='directory') THEN
    RAISE EXCEPTION 'ORBITA_PG_PARENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT backend_start INTO STRICT started FROM pg_catalog.pg_stat_get_activity(pg_backend_pid());
  saved_store=orbita_common.store_id();
  FOR item IN SELECT * FROM orbita_common.entries WHERE workspace_id=workspace AND
    (path=source OR starts_with(path,source || '/')) ORDER BY length(path),path COLLATE "C" LOOP
    new_id=NULL;
    IF item.kind='store' THEN
      SELECT * INTO STRICT original FROM orbita_private.stores WHERE workspace_id=workspace AND id=item.store_id;
      INSERT INTO orbita_private.stores(workspace_id,logical_key,family,revision)
        VALUES(workspace,target || substring(item.path from length(source)+1),original.family,original.revision) RETURNING id INTO new_id;
      UPDATE orbita_private.sessions SET store_id=new_id WHERE pid=pg_backend_pid() AND backend_start=started;
      INSERT INTO orbita_private.tree_operations VALUES(pg_backend_pid(),started,txid_current(),new_id,'clone');
      FOR rel IN SELECT * FROM orbita_private.ordered_tables(original.family) ORDER BY copy_order LOOP
        SELECT string_agg(format('%I',attname),',' ORDER BY attnum) INTO fields FROM pg_attribute
          WHERE attrelid=to_regclass(format('%I.%I','orbita_' || original.family,rel.table_name))
          AND attnum>0 AND NOT attisdropped AND attgenerated='' AND attname<>'_store_id';
        EXECUTE format('INSERT INTO %I.%I (_store_id,%s) SELECT $1,%s FROM %I.%I WHERE _store_id=$2 ORDER BY rowid',
          'orbita_' || original.family,rel.table_name,fields,fields,'orbita_' || original.family,rel.table_name) USING new_id,item.store_id;
        GET DIAGNOSTICS affected=ROW_COUNT;rows_count=rows_count+affected;
      END LOOP;
      INSERT INTO orbita_private.row_counters(store_id,relation_name,value)
        SELECT new_id,relation_name,value FROM orbita_private.row_counters WHERE store_id=item.store_id
        ON CONFLICT ON CONSTRAINT row_counters_pkey DO UPDATE SET value=GREATEST(orbita_private.row_counters.value,excluded.value);
      INSERT INTO orbita_private.store_catalog SELECT new_id,name,kind,source_sql FROM orbita_private.store_catalog WHERE store_id=item.store_id;
      DELETE FROM orbita_private.tree_operations WHERE pid=pg_backend_pid() AND backend_start=started
        AND transaction_id=txid_current() AND store_id=new_id;
      stores_count=stores_count+1;
    END IF;
    INSERT INTO orbita_common.entries(workspace_id,path,kind,object_id,store_id,revision,created_at,modified_at)
      VALUES(workspace,target || substring(item.path from length(source)+1),item.kind,item.object_id,new_id,item.revision,item.created_at,item.modified_at);
  END LOOP;
  UPDATE orbita_private.sessions SET store_id=saved_store WHERE pid=pg_backend_pid() AND backend_start=started;
  SELECT count(*) INTO entries_count FROM orbita_common.entries WHERE workspace_id=workspace AND (path=target OR starts_with(path,target || '/'));
  RETURN jsonb_build_object('entries',entries_count,'stores',stores_count,'rows',rows_count);
END $$;

REVOKE ALL ON FUNCTION orbita_private.tree_authorized(uuid,text),orbita_private.ordered_tables(text),orbita_common.reject_row_change(),
  orbita_common.register_writer(uuid,text),orbita_common.purge_tree(text,boolean,boolean),orbita_common.clone_tree(text,text) FROM PUBLIC,orbita_runtime;
GRANT EXECUTE ON FUNCTION orbita_common.register_writer(uuid,text),orbita_common.purge_tree(text,boolean,boolean),orbita_common.clone_tree(text,text) TO orbita_runtime;
