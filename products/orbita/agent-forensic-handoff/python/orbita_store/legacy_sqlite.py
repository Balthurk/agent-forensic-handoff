"""Explicit, read-only SQLite custody and conversion to installed row streams.

This module is an operator import boundary, never an operational fallback.
Native sources must be named and hash-bound. On Windows a held read handle
denies writes/deletion for the entire inspection and conversion. No source DDL
is executed in PostgreSQL, and no historical lock or capability is restored.
"""
from contextlib import ExitStack
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import struct
import time
from urllib.parse import quote

from .config import binding_for, plain_local_path, require
from .manifests import Limits, frame, stable
from .schema import definitions, ident, table_definition
from .session import Session
from .sql import parse
from .transfers import MAGIC, metadata, result_manifest
from .objects import BLOCK

VEC_SHA256='fcf98662a7ad9dce394b96a88f91032047823831b951c76636787c312a6476e6'
OLD_CHUNK_FIELDS=('start_cp','end_cp','token_count','representation_id','source_text_sha256')
EXPORT_REVISION_SQL='CREATE TABLE orbita_export_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL)'


class NativeReadHold:
    """Held, read-only, no-write/no-delete sharing; no historical PID actions."""
    def __init__(self,path,expected_sha256=None,*,max_bytes=None):
        self.file=None
        require(os.name=='nt','LEGACY_NATIVE_PLATFORM_UNQUALIFIED')
        require(Path(path).is_absolute(),'LEGACY_ABSOLUTE_SOURCE_REQUIRED')
        self.path=plain_local_path(path)
        from afh_semantic.path_safety import native_path
        self.native=native_path(self.path)
        before=self.native.lstat()
        require(stat.S_ISREG(before.st_mode) and before.st_nlink==1,'LEGACY_REGULAR_UNALIASED_FILE_REQUIRED')
        from .native_read import HeldNativeReader
        self.file=HeldNativeReader(self.native)
        try:
            self.identity=self.file.identity
            require((before.st_dev,before.st_ino)==(self.identity.st_dev,self.identity.st_ino),'LEGACY_SOURCE_REPLACED')
            require(max_bytes is None or type(max_bytes) is int and 0<=self.identity.st_size<=max_bytes,'LEGACY_SOURCE_BYTE_BUDGET')
            self.sha256=self.hash()
            require(expected_sha256 is None or self.sha256==expected_sha256,'LEGACY_SOURCE_HASH')
        except BaseException:self.close();raise

    def hash(self):
        self.file.seek(0);digest=hashlib.sha256()
        while chunk:=self.file.read(BLOCK):digest.update(chunk)
        self.file.seek(0);return digest.hexdigest()

    @property
    def sqlite_uri(self):
        # Percent-encode the native Win32 spelling. Path.as_uri() interprets
        # the extended prefix as a URI authority; an ordinary spelling still
        # hits SQLite's legacy Windows path limit. Keep immutable/read-only
        # options and the held source identity for both short and long paths.
        return 'file:'+quote(str(self.native),safe=':')+'?mode=ro&immutable=1'

    def verify(self):
        current=self.native.lstat()
        require((current.st_dev,current.st_ino,current.st_size,current.st_mtime_ns)==
                (self.identity.st_dev,self.identity.st_ino,self.identity.st_size,self.identity.st_mtime_ns),'LEGACY_SOURCE_CHANGED')
        require(self.hash()==self.sha256,'LEGACY_SOURCE_CHANGED')

    def close(self):
        if self.file is not None:self.file.close();self.file=None
    def __enter__(self):return self
    def __exit__(self,*unused):self.close()


def installed_structure(path,family,config):
    """Inspect a tentative new locator, then roll back every probe effect."""
    binding,key=binding_for(path,config)
    with Session(config,binding) as session:
        session.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ')
        try:
            session.raw.execute('SELECT orbita_common.begin_store_import(%s,%s)',(key,family))
            structure=session.raw.execute('SELECT orbita_common.transfer_structure()').fetchone()[0]
            reviewed=installed_definitions(family)
            rows=session.raw.execute('SELECT name,kind,source_sql,source_hash FROM orbita_common.catalogue(%s)',(family,)).fetchall()
            require({r[0]:r[3] for r in rows}=={n:d['source_hash'] for n,d in reviewed.items()},'LEGACY_INSTALLED_SCHEMA_MISMATCH')
            # SQL formatting in the first installation can differ from the
            # current bundle. Canonical identity must match, while a transfer
            # retains the exact installed text required by the server guard.
            for name,kind,source,source_hash in rows:
                parsed=list(definitions(source,family))
                require(len(parsed)==1 and parsed[0]['name']==name and parsed[0]['kind']==kind and parsed[0]['source_hash']==source_hash,'LEGACY_INSTALLED_CATALOGUE_MISMATCH')
            structure['shape']['catalogue']=[dict(name=n,kind=k,source=s) for n,k,s,h in sorted(rows)]
            return structure
        finally:session.raw.rollback()


def installed_definitions(family):
    root=Path(__file__).with_name('schemas')
    bundle=json.loads((root/'manifest.json').read_text(encoding='utf8'))
    require(family in bundle['families'],'LEGACY_UNKNOWN_FAMILY')
    entry=bundle['families'][family]
    require(entry['file']==family+'.sql','LEGACY_SCHEMA_PATH')
    raw=(root/entry['file']).read_bytes()
    require(hashlib.sha256(raw).hexdigest()==entry['sha256'],'SCHEMA_SOURCE_HASH')
    result={x['name']:x for x in definitions(raw.decode('utf8'),family)}
    require({k:v['source_hash'] for k,v in result.items()}==entry['members'],'SCHEMA_MEMBER_HASH')
    return result


def normalized_table(source,*,drop_columns=()):
    node=parse(source).copy();node.set('exists',False)
    if drop_columns:node.this.set('expressions',[c for c in node.this.expressions if c.name.lower() not in drop_columns])
    return node.sql(dialect='sqlite',normalize=True,comments=False)


def checked_export_metadata(db,ddl,family):
    """Recognize the complete I05 export marker, never execute its DDL.

    These literal definitions come from the sealed I05 export_held writer.
    Prefixes alone never authorize a trigger/index, a partial set or a new
    function. Native bytes and SQL stay in custody; none enters the PG schema.
    """
    names={n for n in ddl if n.startswith('orbita_export_')}
    if not names:return set(),[]
    require(family in ('semantic','corpus'),'LEGACY_EXPORT_METADATA_FAMILY')
    expected={'orbita_export_revision':dict(kind='table',source=EXPORT_REVISION_SQL)}
    if family=='semantic':
        if 'record_versions' in ddl:
            expected['orbita_export_first_source']=dict(kind='index',source="CREATE INDEX orbita_export_first_source ON record_versions(json_extract(payload,'$.source_refs[0].id'))")
            expected['orbita_export_multisource']=dict(kind='index',source="CREATE INDEX orbita_export_multisource ON record_versions(record_id) WHERE json_array_length(payload,'$.source_refs')>1")
        for table in ('record_versions','semantic_support_admissions'):
            if table not in ddl:continue
            for event in ('INSERT','UPDATE','DELETE'):
                name='orbita_export_'+event.lower()+'_'+table
                expected[name]=dict(kind='trigger',source=f'CREATE TRIGGER {name} AFTER {event} ON {table} BEGIN UPDATE orbita_export_revision SET revision=revision+1 WHERE id=1; END')
    require(names==set(expected),'LEGACY_EXPORT_METADATA_DEFINITIONS')
    canonical=lambda value:re.sub(r'\s+',' ',value.strip().rstrip(';')).strip()
    for name,wanted in expected.items():
        actual=ddl[name]
        require(actual['kind']==wanted['kind'] and isinstance(actual['source'],str),'LEGACY_EXPORT_METADATA_DEFINITION')
        if wanted['kind']=='table':
            require(normalized_table(actual['source'])==normalized_table(wanted['source']),'LEGACY_EXPORT_METADATA_SCHEMA')
        else:require(canonical(actual['source'])==canonical(wanted['source']),'LEGACY_EXPORT_METADATA_DEFINITION')
    rows=db.execute('SELECT id,revision FROM orbita_export_revision LIMIT 2').fetchall()
    require(len(rows)==1 and rows[0][0]==1 and type(rows[0][1]) is int and 0<=rows[0][1]<2**63,'LEGACY_EXPORT_METADATA_REVISION')
    custody=[dict(name=name,kind=ddl[name]['kind'],sourceSha256=hashlib.sha256(ddl[name]['source'].encode('utf8')).hexdigest(),
                  reason='historical-export-metadata-only',**(dict(rows=1,revision=rows[0][1]) if name=='orbita_export_revision' else {})) for name in sorted(names)]
    return names,custody


class SqliteTransfer:
    """Two bounded passes over one immutable, held source; exact typed stream."""
    def __init__(self,source,expected_sha256,*,family,structure,limits=None,vector_extension=None):
        self.stack=ExitStack();self.closed=False;self.done=False;self.pending=memoryview(b'');self.iterator=None
        self.limits=limits or Limits();self.deadline=time.perf_counter()+self.limits.seconds
        self.delivered=0;self.family=family
        try:
            require(isinstance(expected_sha256,str) and re.fullmatch('[0-9a-f]{64}',expected_sha256),'LEGACY_EXPECTED_HASH_REQUIRED')
            self.hold=self.stack.enter_context(NativeReadHold(source,expected_sha256))
            from afh_semantic.path_safety import native_path
            for suffix in ('-wal','-journal'):
                sidecar=Path(str(self.hold.path)+suffix)
                if native_path(sidecar).exists():
                    held=self.stack.enter_context(NativeReadHold(sidecar))
                    require(held.identity.st_size==0,'LEGACY_COHERENT_SNAPSHOT_REQUIRED')
            self.db=sqlite3.connect(self.hold.sqlite_uri,uri=True)
            self.stack.callback(self.db.close)
            self.db.execute('PRAGMA query_only=ON');self.db.execute('PRAGMA trusted_schema=OFF')
            self.db.set_progress_handler(lambda:1 if time.perf_counter()>=self.deadline else 0,1000)
            self.check()
            self.definitions=installed_definitions(family)
            self.header=dict(schema='orbita-row-transfer-1',**json.loads(json.dumps(structure)))
            self.shape=self.header['shape'];require(self.shape['family']==family,'LEGACY_FAMILY_MISMATCH')
            expected_tables={n:d for n,d in self.definitions.items() if d['kind']=='table'}
            require({t['name']:t['sourceHash'] for t in self.shape['tables']}=={n:d['source_hash'] for n,d in expected_tables.items()},'LEGACY_INSTALLED_SCHEMA_MISMATCH')
            rows=self.db.execute("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
            require(len(rows)<=512,'LEGACY_SCHEMA_BUDGET')
            self.ddl={n:dict(kind=k,source=s) for n,k,s in rows}
            self.tables={n:v for n,v in self.ddl.items() if v['kind']=='table'}
            export_names,self.custody=checked_export_metadata(self.db,self.ddl,family)
            self.mappings=[];self.ordinal={};self.vector_dimensions=None
            virtual={n for n,d in self.tables.items() if re.match(r'CREATE\s+VIRTUAL\s+TABLE\b',d['source'] or '',re.I)}
            shadow=set()
            for name in virtual:
                if name=='vector_index':
                    shadow.update(n for n in self.tables if n in ('vector_index_info','vector_index_chunks','vector_index_rowids') or re.fullmatch(r'vector_index_vector_chunks[0-9]{2}',n))
                else:shadow.update(name+s for s in ('_data','_idx','_content','_docsize','_config'))
            require(all(d['kind']=='table' or n in self.definitions or n in shadow or n in export_names for n,d in self.ddl.items()),'LEGACY_UNKNOWN_DEFINITION')
            for name,entry in self.tables.items():
                self.check()
                if name in shadow:continue
                if name in export_names:continue
                require(name in expected_tables,'LEGACY_UNKNOWN_TABLE:'+name)
                expected=expected_tables[name]
                if family=='vector' and name=='vector_index':
                    found=re.fullmatch(r'CREATE\s+VIRTUAL\s+TABLE\s+vector_index\s+USING\s+vec0\s*\(\s*embedding\s+float\[(\d+)\]\s+distance_metric\s*=\s*cosine\s*\)',entry['source'],re.I)
                    require(found is not None,'LEGACY_VECTOR_SCHEMA')
                    self.vector_dimensions=int(found[1]);require(0<self.vector_dimensions<=65536,'LEGACY_VECTOR_DIMENSIONS')
                    require(vector_extension is not None,'LEGACY_VECTOR_ORACLE_REQUIRED')
                    dll=self.stack.enter_context(NativeReadHold(vector_extension,VEC_SHA256))
                    self.db.enable_load_extension(True)
                    try:self.db.load_extension(str(dll.path))
                    finally:self.db.enable_load_extension(False)
                    chunks={v[0]:i for i,v in enumerate(self.db.execute('SELECT chunk_id FROM vector_index_chunks ORDER BY chunk_id'))}
                    for rowid,chunk,slot in self.db.execute('SELECT rowid,chunk_id,chunk_offset FROM vector_index_rowids'):
                        require(type(slot) is int and 0<=slot<1024 and chunk in chunks,'LEGACY_VECTOR_PHYSICAL_ORDER')
                        require(len(self.ordinal)<self.limits.rows,'LEGACY_ROW_BUDGET')
                        self.ordinal[rowid]=chunks[chunk]*1024+slot+1
                    require(len(set(self.ordinal.values()))==len(self.ordinal),'LEGACY_VECTOR_PHYSICAL_ORDER')
                    self.mappings.append(dict(table=name,kind='vec0-physical-order',dimensions=self.vector_dimensions,extensionSha256=VEC_SHA256))
                    continue
                if expected['definition']['virtual']:
                    actual=table_definition(entry['source'],family)
                    require(actual['source_hash']==expected['source_hash'],'LEGACY_TABLE_SCHEMA:'+name)
                    continue
                columns=[c[1] for c in self.db.execute('PRAGMA table_info('+ident(name)+')')]
                missing=[c['name'] for c in expected['definition']['columns'] if c['name'] not in columns]
                if missing:
                    require(family=='vector' and name=='semantic_chunk' and tuple(missing)==OLD_CHUNK_FIELDS,'LEGACY_MISSING_COLUMNS:'+name)
                    require(normalized_table(entry['source'])==normalized_table(expected['source_sql'],drop_columns=missing),'LEGACY_TABLE_SCHEMA:'+name)
                    self.mappings.append(dict(table=name,kind='absent-nullable-columns',columns=missing))
                else:require(normalized_table(entry['source'])==normalized_table(expected['source_sql']),'LEGACY_TABLE_SCHEMA:'+name)
            require(self.db.execute('PRAGMA integrity_check').fetchall()==[('ok',)],'LEGACY_SQLITE_INTEGRITY')
            # Archive SQL is retained only as provenance. Runtime catalogue
            # source text always comes from the reviewed installed bundle.
            installed_catalogue=self.shape['catalogue']
            require({c['name'] for c in installed_catalogue}==set(self.definitions),'LEGACY_INSTALLED_CATALOGUE_MISMATCH')
            self.shape['catalogue']=[c for c in installed_catalogue if c['name'] in self.ddl]
            self.shape['counters']={};self.counts={};self.row_count=0;self.typed_bytes=0
            sequences=dict(self.db.execute('SELECT name,seq FROM sqlite_sequence')) if self.db.execute("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").fetchone() else {}
            self.table_shapes={t['name']:t for t in self.shape['tables']}
            for name in self.header['order']:
                observed,maximum=self.scan(name)
                self.counts[name]=observed
                sequence=sequences.get(name,0)
                require(type(sequence) is int and 0<=sequence<2**63,'LEGACY_SEQUENCE')
                self.shape['counters'][family+'.'+name]=max(0,maximum,sequence)
            if self.ordinal:self.shape['counters']['vector._index_ordinal']=max(self.ordinal.values())
            self.manifest=result_manifest(family,list(self.counts.values()),self.shape)
            self.size=len(MAGIC)+len(metadata(self.header))+1+len(metadata(self.manifest))
            for count in self.counts.values():self.size+=5+count['rows']*5+count['typedBytes']+1+len(metadata(count))
            self.info=dict(format='orbita-row-transfer-1',family=family,size=self.size,rowsSha256=self.manifest['sha256'],manifest=self.manifest)
            self.provenance=dict(schema='orbita-legacy-sqlite-1',sourceSha256=self.hold.sha256,sourceSize=self.hold.identity.st_size,
                                 family=family,mappings=self.mappings,custody=self.custody,sourceCatalogue=self.ddl,rowsSha256=self.manifest['sha256'])
            self.iterator=self.pieces();self.check()
        except BaseException:self.close();raise

    def check(self):require(time.perf_counter()<self.deadline,'LEGACY_DEADLINE')

    def rows(self,name):
        if name not in self.tables:return
        columns=self.table_shapes[name]['columns']
        native={c[1] for c in self.db.execute('PRAGMA table_info('+ident(name)+')')}
        selections=['rowid' if c['name']=='_index_ordinal' else ident(c['name']) if c['name'] in native or c['name']=='rowid' else 'NULL' for c in columns]
        self.check()
        # Fetch one row at a time; preflight lengths prevents an unbounded field
        # allocation before Python can check its budget.
        widths=' OR '.join('length(CAST('+v+' AS BLOB))>?' for v in selections)
        require(self.db.execute('SELECT 1 FROM '+ident(name)+' WHERE '+widths+' LIMIT 1',(self.limits.field_bytes,)*len(selections)).fetchone() is None,'LEGACY_FIELD_BUDGET')
        for values in self.db.execute('SELECT '+','.join(selections)+' FROM '+ident(name)+' ORDER BY rowid'):
            self.check();values=list(values)
            for index,col in enumerate(columns):
                if col['name']=='_index_ordinal':
                    require(values[index] in self.ordinal,'LEGACY_VECTOR_PHYSICAL_ORDER');values[index]=self.ordinal[values[index]]
                value=values[index]
                require(value is None or col['type']=='bigint' and type(value) is int or col['type']=='text' and isinstance(value,str) and '\0' not in value
                        or col['type']=='bytea' and isinstance(value,bytes) or col['type']=='double precision' and type(value) is float,'LEGACY_TYPE_MISMATCH:'+name+'.'+col['name'])
                require(value is not None or not col['notNull'],'LEGACY_NULL_CONSTRAINT:'+name+'.'+col['name'])
            if name=='vector_index':
                require(len(values[next(i for i,c in enumerate(columns) if c['name']=='embedding')])==self.vector_dimensions*4,'LEGACY_VECTOR_BYTES')
            yield values

    def scan(self,name):
        digest=hashlib.sha256();count=size=maximum=0;shape=self.table_shapes[name]
        rowid=next(i for i,c in enumerate(shape['columns']) if c['name']=='rowid')
        for row in self.rows(name):
            count+=1;self.row_count+=1;require(self.row_count<=self.limits.rows,'LEGACY_ROW_BUDGET')
            maximum=max(maximum,row[rowid]);digest.update(b'R'+struct.pack('>I',len(row)))
            for value in row:
                encoded=frame(value);require(len(encoded)<=self.limits.field_bytes+9,'LEGACY_FIELD_BUDGET')
                size+=len(encoded);self.typed_bytes+=len(encoded);require(self.typed_bytes<=self.limits.bytes,'LEGACY_BYTE_BUDGET');digest.update(encoded)
        return dict(name=name,schemaSha256=hashlib.sha256(stable(shape)).hexdigest(),rows=count,typedBytes=size,sha256=digest.hexdigest()),maximum

    def pieces(self):
        yield MAGIC;yield metadata(self.header)
        for index,name in enumerate(self.header['order']):
            yield b'T'+struct.pack('>I',index);digest=hashlib.sha256();count=size=0
            for row in self.rows(name):
                marker=b'R'+struct.pack('>I',len(row));digest.update(marker);count+=1;yield marker
                for value in row:
                    encoded=frame(value);digest.update(encoded);size+=len(encoded);yield encoded
            expected=self.counts[name]
            require((count,size,digest.hexdigest())==(expected['rows'],expected['typedBytes'],expected['sha256']),'LEGACY_SECOND_PASS_MISMATCH')
            yield b'E'+metadata(expected)
        self.hold.verify();self.check();yield b'Z'+metadata(self.manifest)

    def read(self,length=BLOCK):
        require(type(length) is int and 0<=length<=BLOCK,'TRANSFER_READ_BUDGET')
        if self.done:return b''
        require(not self.closed,'TRANSFER_CLOSED');parts=[];size=0;self.check()
        while size<length:
            if not self.pending:
                try:self.pending=memoryview(next(self.iterator))
                except StopIteration:
                    require(self.delivered+size==self.size,'TRANSFER_SIZE_MISMATCH');self.done=True;break
            n=min(length-size,len(self.pending));parts.append(bytes(self.pending[:n]));self.pending=self.pending[n:];size+=n
        self.delivered+=size;return b''.join(parts)

    def close(self):
        if self.closed:return
        self.closed=True
        try:
            if self.iterator is not None:self.iterator.close()
        finally:self.stack.close()
    def __enter__(self):return self
    def __exit__(self,*unused):self.close()
