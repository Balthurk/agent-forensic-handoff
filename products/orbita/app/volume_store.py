"""Common PostgreSQL volume worker; native files require explicit export."""
import json,sys
from volume_common import Store,VolumeError,canonical,digest,PRIMARY,ANALYTICS,demand,plain
from orbita_store.pool import close_idle

def main():
    store=None
    try:
        raw=sys.stdin.buffer.read(12*1024**2+1)
        demand(len(raw)<=12*1024**2,'REQUEST_BUDGET')
        request=json.loads(raw);demand(isinstance(request,dict),'INPUT')
        op=request.get('op','status')
        demand(op in ('prepare','append','status','page','lake','verify','export-parquet','verify-export'),'OPERATION')
        store=Store(request['root'])
        if op=='prepare':result=store.prepare(request['catalog'])
        elif op=='append':result=store.append(request['source'],request['expectedAfter'],request['after'],request['rows'],request['complete'])
        elif op=='page':result=store.query(request,request.get('backend',PRIMARY))
        elif op=='lake':result=store.lake(request.get('limit',500))
        elif op=='verify':result=store.verify_lake()
        elif op=='export-parquet':result=store.export_parquet(request['destination'])
        elif op=='verify-export':result=store.verify_export(request['receipt'])
        else:result=store.status()
    finally:
        try:
            if store is not None:store.close()
        finally:close_idle()
    print(canonical(result))

if __name__=='__main__':
    try:main()
    except VolumeError as error:print(canonical({'error':str(error)}));sys.exit(1)
    except Exception:print(canonical({'error':'VOLUME_DEPENDENCY_OR_STORAGE_ERROR'}));sys.exit(1)
