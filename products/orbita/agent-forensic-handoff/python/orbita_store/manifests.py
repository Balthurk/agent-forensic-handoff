"""Portable typed row manifest, streamed in one repeatable-read snapshot."""
from dataclasses import dataclass
from contextlib import closing
import hashlib,json,math,struct,threading,time
import psycopg
from . import StoreError
from .config import require
from .schema import ident

@dataclass(frozen=True)
class Limits:
    rows:int=1000000
    bytes:int=512*1024*1024
    field_bytes:int=64*1024*1024
    seconds:float=45

def stable(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode('utf8')
def frame(value):
    if value is None:return b'N'
    if isinstance(value,(bytes,bytearray,memoryview)):kind=b'B';raw=bytes(value)
    elif type(value) is int:kind=b'I';raw=str(value).encode('ascii')
    elif type(value) is float:
        require(math.isfinite(value),'MANIFEST_NONFINITE');kind=b'F';raw=struct.pack('>d',value)
    elif isinstance(value,str):kind=b'T';raw=value.encode('utf8')
    else:raise StoreError('ORBITA_PG_MANIFEST_VALUE_TYPE')
    return kind+struct.pack('>Q',len(raw))+raw

def manifest(connection,*,limits=None):
    limits=limits or Limits();deadline=time.perf_counter()+limits.seconds
    outer=not connection.in_transaction
    if outer:connection.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    cancelled=threading.Event()
    def cancel():
        cancelled.set()
        try:connection.raw.cancel_safe(timeout=5)
        except psycopg.Error:pass
    timer=threading.Timer(limits.seconds,cancel);timer.daemon=True
    def check():require(time.perf_counter()<deadline,'MANIFEST_DEADLINE')
    try:
        require(connection.raw.execute('SHOW transaction_isolation').fetchone()[0] in ('repeatable read','serializable'),'MANIFEST_REPEATABLE_SNAPSHOT_REQUIRED')
        timer.start()
        with connection.raw.transaction():
            shape=connection.raw.execute('SELECT orbita_common.store_structure()').fetchone()[0];check()
            require(shape['family']==connection.family and bool(shape['tables']),'MANIFEST_CATALOGUE')
            # Only two booleans per table cross the wire in this pipeline.
            # Every header is read afresh under the same repeatable snapshot
            # as the typed row stream; no row, schema or empty-table cache.
            headers=[]
            with connection.raw.pipeline():
                for table in shape['tables']:
                    check()
                    widths=','.join('octet_length('+ident(c['name'])+(')' if c['type']=='bytea' else '::text)') for c in table['columns'])
                    name=ident('orbita_'+connection.family)+'.'+ident(table['name'])
                    headers.append(connection.raw.execute('SELECT EXISTS(SELECT 1 FROM '+name+'),EXISTS(SELECT 1 FROM '+name+' WHERE GREATEST('+widths+')>%s)',(limits.field_bytes,)))
            tables=[];total_rows=total_bytes=0
            for table,header in zip(shape['tables'],headers,strict=True):
                check();digest=hashlib.sha256();rows=bytes_count=0
                columns=','.join(ident(c['name']) for c in table['columns'])
                # Reject huge rows before fetching their payloads into the client.
                name=ident('orbita_'+connection.family)+'.'+ident(table['name'])
                present,too_large=header.fetchone();header.close()
                require(not too_large,'MANIFEST_FIELD_BUDGET')
                # Single-row libpq streaming avoids DECLARE/FETCH/CLOSE round
                # trips for every small relation, retaining bounded memory and
                # the same repeatable snapshot, row order and typed digest.
                # An excess row is still fetched and rejected, never truncated
                # into a partial successful manifest. Closing also cancels and
                # drains an unfinished stream before rollback/reuse.
                if present:
                    with connection.raw.cursor() as cursor:
                        query='SELECT '+columns+' FROM '+name+' ORDER BY rowid LIMIT %s'
                        with closing(cursor.stream(query,(max(1,limits.rows-total_rows+1),))) as stream:
                            for row in stream:
                                check();rows+=1;total_rows+=1;require(total_rows<=limits.rows,'MANIFEST_ROW_BUDGET')
                                digest.update(b'R'+struct.pack('>I',len(row)))
                                for value in row:
                                    encoded=frame(value);bytes_count+=len(encoded);total_bytes+=len(encoded)
                                    require(total_bytes<=limits.bytes,'MANIFEST_BYTE_BUDGET');digest.update(encoded)
                tables.append(dict(name=table['name'],schemaSha256=hashlib.sha256(stable(table)).hexdigest(),rows=rows,typedBytes=bytes_count,sha256=digest.hexdigest()))
            result=dict(format='orbita-common-rows-1',family=connection.family,tables=tables,rows=total_rows,typedBytes=total_bytes,
                catalogueSha256=hashlib.sha256(stable(shape['catalogue'])).hexdigest(),countersSha256=hashlib.sha256(stable(shape['counters'])).hexdigest())
            result['sha256']=hashlib.sha256(stable(result)).hexdigest();check()
        if outer:connection.raw.commit()
        return result
    except BaseException as error:
        if outer and not connection.raw.closed:connection.raw.rollback()
        if isinstance(error,psycopg.errors.QueryCanceled) and cancelled.is_set():raise StoreError('ORBITA_PG_MANIFEST_DEADLINE') from None
        raise
    finally:
        timer.cancel()
        if timer.ident is not None:timer.join()
