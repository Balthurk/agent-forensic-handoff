"""Compile declared table definitions into shared PostgreSQL family tables.

Only an operator installs these definitions. Runtime DDL can bind an installed
definition to a logical store; it cannot execute CREATE/ALTER as an owner.
"""
import hashlib
import json
import re
from pathlib import Path
from sqlglot import exp,parse_one

from . import StoreError
from .config import require
from .sql import parse,postgres,statements,canonical_sql


def ident(value):
    require(isinstance(value,str) and re.fullmatch('[a-zA-Z_][a-zA-Z_0-9]{0,62}',value),'SQL_IDENTIFIER')
    return '"'+value.lower()+'"'


def qtable(family,name):return ident('orbita_'+family)+'.'+ident(name)
def digest(value):return hashlib.sha256(value.encode('utf8')).hexdigest()
def names(expressions):return [e.name.lower() for e in expressions]


def normalize_json(node):
    def transform(item):
        if isinstance(item,(exp.JSONExtract,exp.JSONExtractScalar)):
            item.set('this',exp.Cast(this=item.this.copy(),to=exp.DataType.build('JSON')))
        return item
    return node.transform(transform)


def table_definition(statement,family):
    fts=re.fullmatch(r'CREATE\s+VIRTUAL\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+USING\s+fts5\((.*)\)',statement.strip(),re.I|re.S)
    virtual=None
    if fts:
        cols=[];indexed=[]
        for part in fts[2].split(','):
            part=part.strip()
            if re.fullmatch(r"tokenize\s*=\s*'unicode61'",part,re.I):continue
            found=re.fullmatch(r'(\w+)(?:\s+(UNINDEXED))?',part,re.I)
            require(found is not None,'FTS_DEFINITION_UNSUPPORTED')
            cols.append(found[1].lower())
            if not found[2]:indexed.append(found[1].lower())
        virtual=dict(engine='fts5-contract',indexed=indexed,tokenizer='unicode61')
        source='CREATE TABLE IF NOT EXISTS '+fts[1]+'('+','.join(ident(x)+' TEXT' for x in cols)+')'
        normalized='fts5:'+json.dumps(dict(name=fts[1].lower(),columns=cols,**virtual),sort_keys=True,separators=(',',':'))
    else:
        source=statement;normalized=canonical_sql(statement)
    tree=parse(source)
    require(isinstance(tree,exp.Create) and tree.args.get('kind')=='TABLE' and isinstance(tree.this,exp.Schema),'TABLE_DEFINITION_REQUIRED')
    name=tree.this.this.name.lower();ident(name);ident(family)
    columns=[];column_sql=[];primary=[];uniques=[];foreign=[];checks=[];rowid_alias=None
    for element in tree.this.expressions:
        if isinstance(element,exp.ColumnDef):
            col=element.copy();field=col.name.lower();col.set('this',exp.to_identifier(field))
            require(field!='_store_id','RESERVED_COLUMN')
            kind=col.args['kind'];original=kind.this
            if original in (exp.DataType.Type.INT,exp.DataType.Type.BIGINT):col.set('kind',exp.DataType.build('BIGINT'))
            elif original in (exp.DataType.Type.FLOAT,exp.DataType.Type.DOUBLE):col.set('kind',exp.DataType.build('DOUBLE PRECISION'))
            retained=[];pk=False;required=False
            for wrapper in col.args.get('constraints',[]):
                constraint=wrapper.args['kind']
                if isinstance(constraint,exp.PrimaryKeyColumnConstraint):primary.append(field);pk=True
                elif isinstance(constraint,exp.UniqueColumnConstraint):uniques.append([field])
                elif isinstance(constraint,exp.Reference):foreign.append(([field],constraint.this.this.name.lower(),names(constraint.this.expressions),constraint.args.get('options',[])))
                elif isinstance(constraint,exp.AutoIncrementColumnConstraint):continue
                else:
                    required=required or isinstance(constraint,exp.NotNullColumnConstraint)
                    retained.append(wrapper)
            if pk and original==exp.DataType.Type.INT:
                rowid_alias=field
                retained.append(exp.ColumnConstraint(kind=exp.DefaultColumnConstraint(this=parse_one("SELECT orbita_common.next_rowid('"+family+'.'+name+"')",read='postgres').expressions[0])))
            if pk and not required:retained.append(exp.ColumnConstraint(kind=exp.NotNullColumnConstraint()))
            col.set('constraints',retained)
            columns.append(dict(name=field,type=col.args['kind'].sql(dialect='postgres'),notnull=required or pk,primary=pk))
            column_sql.append(postgres(normalize_json(col)))
        elif isinstance(element,exp.PrimaryKey):primary.extend(names(element.expressions))
        elif isinstance(element,exp.UniqueColumnConstraint):uniques.append(names(element.this.expressions))
        elif isinstance(element,exp.ForeignKey):
            ref=element.args['reference'];foreign.append((names(element.expressions),ref.this.this.name.lower(),names(ref.this.expressions),ref.args.get('options',[])))
        elif isinstance(element,exp.CheckColumnConstraint):checks.append(postgres(element))
        else:raise StoreError('ORBITA_PG_TABLE_CONSTRAINT_UNSUPPORTED')
    require(bool(columns),'EMPTY_TABLE')
    for key in primary:
        next(c for c in columns if c['name']==key)['primary']=True
    prefix='_store_id UUID NOT NULL DEFAULT orbita_common.store_id()'
    definitions=[prefix,*column_sql]
    if rowid_alias and rowid_alias!='rowid':definitions.append('rowid BIGINT GENERATED ALWAYS AS ('+ident(rowid_alias)+') STORED')
    elif not any(c['name']=='rowid' for c in columns):definitions.append("rowid BIGINT NOT NULL DEFAULT orbita_common.next_rowid('"+family+'.'+name+"')")
    if primary:definitions.append('PRIMARY KEY (_store_id,'+','.join(map(ident,primary))+')')
    else:definitions.append('PRIMARY KEY (_store_id,rowid)')
    if primary!=['rowid']:definitions.append('UNIQUE (_store_id,rowid)')
    for unique in uniques:definitions.append('UNIQUE (_store_id,'+','.join(map(ident,unique))+')')
    for local,table,remote,options in foreign:
        require(all(re.fullmatch(r'ON (DELETE|UPDATE) (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT)',x,re.I) for x in options),'FOREIGN_KEY_OPTIONS')
        definitions.append('FOREIGN KEY (_store_id,'+','.join(map(ident,local))+') REFERENCES '+qtable(family,table)+'(_store_id,'+','.join(map(ident,remote))+')'+(' '+' '.join(options) if options else ''))
    definitions+=checks
    return dict(name=name,kind='table',family=family,source_sql=statement,source_hash=digest(normalized),definition=dict(columns=columns,primary=primary,unique=uniques,rowidAlias=rowid_alias,virtual=virtual),sql='CREATE TABLE '+qtable(family,name)+'('+',\n'.join(definitions)+')')


def trigger_definition(statement,family):
    match=re.fullmatch(r"CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+BEFORE\s+(UPDATE|DELETE)\s+ON\s+(\w+)\s+BEGIN\s+SELECT\s+RAISE\(ABORT,\s*'append only'\);\s*END",statement,re.I|re.S)
    require(match is not None,'TRIGGER_UNSUPPORTED')
    name,event,table=match.groups();name=name.lower();table=table.lower();event=event.upper()
    return dict(name=name,kind='trigger',family=family,source_sql=statement,source_hash=digest('append-only:'+name+':'+event+':'+table),definition=dict(table=table,event=event),sql='CREATE TRIGGER '+ident(name)+' BEFORE '+event+' ON '+qtable(family,table)+' FOR EACH ROW EXECUTE FUNCTION orbita_common.reject_row_change()')


def index_definition(statement,family):
    tree=parse(statement)
    require(isinstance(tree,exp.Create) and tree.args.get('kind')=='INDEX','INDEX_REQUIRED')
    tree=normalize_json(tree)
    index=tree.this;name=index.this.name.lower();table=index.args['table'].name.lower()
    index.set('this',exp.to_identifier(name));index.args['table'].set('db',exp.to_identifier('orbita_'+family))
    params=index.args['params'];params.set('columns',[exp.Ordered(this=exp.column('_store_id')),*params.args['columns']])
    tree.set('exists',False)
    return dict(name=name,kind='index',family=family,source_sql=statement,source_hash=digest(canonical_sql(statement)),definition=dict(table=table),sql=postgres(tree))


def definitions(script,family):
    for statement in statements(script):
        # Comments can precede a DDL statement in the checked-in schema.
        statement=re.sub(r'^\s*(?:--[^\n]*\n\s*)+','',statement)
        if re.match(r'PRAGMA\b',statement,re.I):continue
        if re.match(r'CREATE\s+(?:VIRTUAL\s+)?TABLE\b',statement,re.I):yield table_definition(statement,family)
        elif re.match(r'CREATE\s+TRIGGER\b',statement,re.I):yield trigger_definition(statement,family)
        elif re.match(r'CREATE\s+(?:UNIQUE\s+)?INDEX\b',statement,re.I):yield index_definition(statement,family)
        else:raise StoreError('ORBITA_PG_INSTALL_DDL_ONLY')


def install_family(db,family,script):
    require(db.execute('SELECT name FROM orbita_private.families WHERE name=%s',(family,)).fetchone() is not None,'UNKNOWN_FAMILY')
    items=list(definitions(script,family))
    require(len({i['name'] for i in items})==len(items),'DUPLICATE_DEFINITION')
    with db.transaction():
        db.execute(Path(__file__).with_name('relational.sql').read_text(encoding='utf8'))
        db.execute('CREATE SCHEMA IF NOT EXISTS '+ident('orbita_'+family))
        db.execute('REVOKE ALL ON SCHEMA '+ident('orbita_'+family)+' FROM PUBLIC')
        db.execute('GRANT USAGE ON SCHEMA '+ident('orbita_'+family)+' TO orbita_runtime')
        db.execute(Path(__file__).with_name('trees.sql').read_text(encoding='utf8'))
        for item in items:
            prior=db.execute('SELECT source_hash FROM orbita_private.schema_catalog WHERE family=%s AND name=%s',(family,item['name'])).fetchone()
            if prior:
                require(prior[0]==item['source_hash'],'INSTALLED_DEFINITION_CHANGED')
                if item['kind']=='table':install_rowid_trigger(db,family,item)
                continue
            db.execute(item['sql'])
            if item['kind']=='table':
                target=qtable(family,item['name'])
                db.execute('ALTER TABLE '+target+' ENABLE ROW LEVEL SECURITY')
                db.execute('ALTER TABLE '+target+' FORCE ROW LEVEL SECURITY')
                db.execute('CREATE POLICY store_read ON '+target+' FOR SELECT USING(_store_id=(SELECT orbita_common.store_id()))')
                db.execute('CREATE POLICY store_write ON '+target+' FOR ALL USING(_store_id=(SELECT orbita_common.store_id()) AND (SELECT orbita_common.can_write())) WITH CHECK(_store_id=(SELECT orbita_common.store_id()) AND (SELECT orbita_common.can_write()))')
                db.execute('GRANT SELECT,INSERT,UPDATE,DELETE ON '+target+' TO orbita_runtime')
                install_rowid_trigger(db,family,item)
            db.execute('INSERT INTO orbita_private.schema_catalog(family,name,kind,source_sql,source_hash,definition) VALUES(%s,%s,%s,%s,%s,%s::jsonb)',(family,item['name'],item['kind'],item['source_sql'],item['source_hash'],json.dumps(item['definition'])))
        db.execute('CREATE OR REPLACE VIEW '+qtable(family,'sqlite_master')+' AS SELECT * FROM orbita_common.logical_catalogue()')
        db.execute('GRANT SELECT ON '+qtable(family,'sqlite_master')+' TO orbita_runtime')
        db.execute('REVOKE ALL ON FUNCTION orbita_common.reject_row_change() FROM PUBLIC')
        if family=='access':
            from .admin import install_managed_protocol
            install_managed_protocol(db)
    return dict(family=family,definitions=len(items),tables=sum(i['kind']=='table' for i in items),hashes={i['name']:i['source_hash'] for i in items})


def install_rowid_trigger(db,family,item):
    table=qtable(family,item['name'])
    if family=='vector' and item['name']=='vector_index':
        # Internal insertion order is required for the qualified legacy KNN
        # tie rule: chunks ascend, slots within each chunk descend. Existing
        # imported rows must supply provenance; never infer it from rowid/ctid.
        db.execute('ALTER TABLE '+table+' ADD COLUMN IF NOT EXISTS _index_ordinal BIGINT')
        db.execute('CREATE UNIQUE INDEX IF NOT EXISTS vector_index_order ON '+table+'(_store_id,_index_ordinal)')
        if not db.execute('SELECT 1 FROM pg_trigger WHERE tgrelid=%s::regclass AND tgname=%s',(table,'orbita_vector_ordinal')).fetchone():
            db.execute('CREATE TRIGGER orbita_vector_ordinal BEFORE INSERT OR UPDATE ON '+table+' FOR EACH ROW EXECUTE FUNCTION orbita_common.assign_vector_ordinal()')
    field=item['definition']['rowidAlias'] or 'rowid'
    existing=db.execute('SELECT 1 FROM pg_trigger WHERE tgrelid=%s::regclass AND tgname=%s',
                        (table,'orbita_assign_rowid')).fetchone()
    if not existing:
        # Identifiers have already passed ident(); literal arguments contain
        # only the same validated letters, digits and underscores.
        ident(field)
        db.execute('CREATE TRIGGER orbita_assign_rowid BEFORE INSERT OR UPDATE ON '+table+
                   " FOR EACH ROW EXECUTE FUNCTION orbita_common.assign_rowid('"+field+"','"+family+'.'+item['name']+"')")
    existing=db.execute('SELECT 1 FROM pg_trigger WHERE tgrelid=%s::regclass AND tgname=%s',(table,'orbita_remember_insert')).fetchone()
    if not existing:
        db.execute('CREATE TRIGGER orbita_remember_insert AFTER INSERT ON '+table+
                   ' FOR EACH ROW EXECUTE FUNCTION orbita_common.remember_insert()')
