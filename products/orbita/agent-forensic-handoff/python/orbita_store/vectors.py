"""Bounded cosine search over exact float32 bytes in common PostgreSQL rows.

Arithmetic and tie ordering are qualified against sqlite-vec 0.1.9; no vector
extension or embedded database participates in runtime. This path is exact
compatibility, not an approximate/index-performance claim.
"""
from dataclasses import dataclass
import hashlib,heapq,math,struct,threading,time,uuid
import psycopg
from . import StoreError
from .config import require

@dataclass(frozen=True)
class Limits:
    rows:int=200000
    bytes:int=128*1024*1024
    seconds:float=30
    dimensions:int=65536

def f32(value):
    try:return struct.unpack('<f',struct.pack('<f',value))[0]
    except OverflowError:return math.copysign(math.inf,value)

def unpack(raw,dimensions=None):
    require(isinstance(raw,(bytes,bytearray,memoryview)) and len(raw)>0 and len(raw)%4==0,'VECTOR_BYTES')
    n=len(raw)//4
    require(dimensions is None or n==dimensions,'VECTOR_DIMENSIONS')
    values=struct.unpack('<'+str(n)+'f',raw)
    require(all(math.isfinite(x) for x in values),'VECTOR_NONFINITE')
    return values

def cosine(a,b):
    require(len(a)==len(b) and bool(a),'VECTOR_DIMENSIONS')
    dot=am=bm=0.0
    for x,y in zip(a,b):
        dot=f32(dot+f32(x*y));am=f32(am+f32(x*x));bm=f32(bm+f32(y*y))
    denominator=math.sqrt(am)*math.sqrt(bm)
    # The old native extension returns SQL NULL for undefined cosine. That
    # must never become JS Number(null)==0 and a false perfect match.
    require(denominator>0,'VECTOR_UNDEFINED_COSINE')
    result=f32(1-dot/denominator)
    require(math.isfinite(result),'VECTOR_UNDEFINED_COSINE')
    return result

def nearest(connection,query,limit,*,limits=None):
    limits=limits or Limits()
    require(connection.family=='vector','VECTOR_FAMILY_REQUIRED')
    require(type(limit) is int and 1<=limit<=4096,'VECTOR_K_LIMIT')
    require(len(query)<=limits.dimensions*4,'VECTOR_DIMENSION_BUDGET')
    wanted=unpack(query);cosine(wanted,wanted)
    outer=not connection.in_transaction
    if outer:connection.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    # Python 3.12 on Windows uses a 15.625ms GetTickCount64 tick for
    # monotonic(); perf_counter is also monotonic with sub-microsecond ticks.
    deadline=time.perf_counter()+limits.seconds;cancelled=threading.Event()
    def cancel():
        cancelled.set()
        try:connection.raw.cancel_safe(timeout=5)
        except psycopg.Error:pass
    timer=threading.Timer(limits.seconds,cancel);timer.daemon=True
    try:
        require(connection.raw.execute('SHOW transaction_isolation').fetchone()[0] in ('repeatable read','serializable'),'VECTOR_REPEATABLE_SNAPSHOT_REQUIRED')
        timer.start();heap=[];rows=0;total=0
        with connection.raw.transaction():
            # FULL JOIN checks both directions before reporting any result.
            sql='''SELECT v.rowid,v._index_ordinal,e.dimensions,e.vector_sha256,
                octet_length(v.embedding),octet_length(e.vector),
                CASE WHEN octet_length(v.embedding)<=%s THEN v.embedding END,
                CASE WHEN octet_length(e.vector)<=%s THEN e.vector END
                FROM vector_index v FULL JOIN semantic_embedding e ON v.rowid=e.rowid
                ORDER BY v._index_ordinal NULLS FIRST'''
            with connection.raw.cursor(name='vectors_'+uuid.uuid4().hex) as cursor:
                cursor.execute(sql,(limits.dimensions*4,limits.dimensions*4))
                while batch:=cursor.fetchmany(32):
                    for rowid,ordinal,dimensions,digest,vsize,esize,vector,source in batch:
                        require(time.perf_counter()<deadline,'VECTOR_DEADLINE')
                        rows+=1;total+=(vsize or 0)+(esize or 0)
                        require(rows<=limits.rows and total<=limits.bytes,'VECTOR_SCAN_BUDGET')
                        require(rowid is not None and ordinal is not None and ordinal>0,'VECTOR_ORDER_OR_INDEX_MISSING')
                        require(dimensions==len(wanted) and vsize==esize==dimensions*4,'VECTOR_DIMENSIONS')
                        require(vector is not None and source is not None and bytes(vector)==bytes(source),'VECTOR_INDEX_MISMATCH')
                        raw=bytes(vector);require(hashlib.sha256(raw).hexdigest()==digest,'VECTOR_HASH')
                        distance=cosine(unpack(raw,len(wanted)),wanted)
                        chunk,slot=divmod(ordinal-1,1024)
                        rank=(distance,chunk,-slot)
                        item=(-rank[0],-rank[1],-rank[2],rowid,distance)
                        if len(heap)<limit:heapq.heappush(heap,item)
                        elif item>heap[0]:heapq.heapreplace(heap,item)
            result=[(r[3],r[4]) for r in sorted(heap,key=lambda x:(-x[0],-x[1],-x[2]))]
            require(time.perf_counter()<deadline,'VECTOR_DEADLINE')
        if outer:connection.raw.commit()
        return result
    except BaseException as error:
        if outer and not connection.raw.closed:connection.raw.rollback()
        if isinstance(error,psycopg.errors.QueryCanceled) and cancelled.is_set():raise StoreError('ORBITA_PG_VECTOR_DEADLINE') from None
        raise
    finally:
        timer.cancel()
        if timer.ident is not None:timer.join()
