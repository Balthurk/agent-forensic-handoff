"""Explicit operator-selected content import; no discovery or crash injection.

The complete receipt is published with the content inside PostgreSQL. stdout
contains its address/hash and counts, never credentials or source row values.
"""
import argparse,hashlib,json,os,re,sys,time,uuid
from pathlib import Path


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('plan','plan-sha256','config','destination','stage'):
        parser.add_argument('--'+name,required=True)
    parser.add_argument('--vector-extension')
    args=parser.parse_args(argv)
    owner=str(uuid.uuid4());os.environ['ORBITA_POSTGRES_OWNER_ID']=owner
    # This entry owns a fresh process. Do not relabel someone else's pool.
    if 'orbita_store.pool' in sys.modules:
        print(json.dumps(dict(status='FAIL',code='ORBITA_PG_CLI_FRESH_PROCESS_REQUIRED')))
        return 1
    from . import StoreError
    from .config import parse_config,require
    from .legacy_sqlite import NativeReadHold
    from .legacy_metadata import _json
    from .legacy_import import import_bundle,stable
    from .ownership import observe_owner
    from .pool import close_idle
    config=None;entered=False;published=False;output=None;closed=None
    try:
        require(re.fullmatch('[0-9a-f]{64}',args.plan_sha256) is not None,'LEGACY_EXPECTED_HASH_REQUIRED')
        for name in ('plan','config','destination','stage'):
            require(Path(getattr(args,name)).is_absolute(),'CLI_ABSOLUTE_PATH_REQUIRED')
        if args.vector_extension:require(Path(args.vector_extension).is_absolute(),'CLI_ABSOLUTE_PATH_REQUIRED')
        with NativeReadHold(args.config,max_bytes=1024**2) as settings, NativeReadHold(args.plan,args.plan_sha256,max_bytes=8*1024**2) as plan_file:
            config=parse_config(_json(settings.file.read()))
            plan=_json(plan_file.file.read());entered=True
            result=import_bundle(plan,args.destination,args.stage,config=config,vector_extension=args.vector_extension)
            published=True;settings.verify();plan_file.verify()
            output=dict(status=result['status'],instanceId=result['instanceId'],workspaceId=result['workspaceId'],
                destination=result['destination'],planSha256=result['planSha256'],entries=len(result['entries']),
                stores=sum(e['kind']=='store' for e in result['entries']),derivations=len(result['derivations']),
                receipt=result['destination']+'/.orbita-legacy/receipt.json',receiptSha256=hashlib.sha256(stable(result)).hexdigest(),
                authorityRestored=False,humanAcceptance=False)
    except BaseException as error:
        code=str(error) if isinstance(error,StoreError) and re.fullmatch(r'ORBITA_PG_[A-Z0-9_]+',str(error)) else 'ORBITA_PG_CLI_INPUT_OR_IMPORT_FAILED'
        output=dict(status='FAIL',code=code,publication='published' if published else 'inspect_destination_before_retry' if entered else 'not_started')
    finally:
        close_idle()
        if entered and config is not None:
            try:
                deadline=time.monotonic()+5
                while True:
                    closed=observe_owner(config,owner)
                    if closed['backends']==0:break
                    if time.monotonic()>=deadline:raise RuntimeError('owned transports still open')
                    time.sleep(.025)
            except BaseException:
                output=dict(status='FAIL',code='ORBITA_PG_CLI_CLOSE_UNVERIFIED',publication='published' if published else 'inspect_destination_before_retry')
                closed=dict(ownerId=owner,backends=None)
        else:closed=dict(ownerId=owner,backends=0,scope='import_not_entered')
    output['consumerClosure']=closed
    print(json.dumps(output,ensure_ascii=False),flush=True)
    return 0 if output['status']=='PASS_EXPLICIT_IMPORT' else 1


if __name__=='__main__':raise SystemExit(main())
