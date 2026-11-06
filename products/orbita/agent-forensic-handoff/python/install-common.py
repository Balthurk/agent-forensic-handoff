"""Explicit operator entrypoint. Credentials are bounded private stdin only."""
from pathlib import Path
import json
import sys

sys.path.insert(0,str(Path(__file__).resolve().parent))
from orbita_store import StoreError
from orbita_store.config import require
from orbita_store.admin import install


def main():
    try:
        require(len(sys.argv)==1,'INSTALL_NO_ARGUMENTS')
        raw=sys.stdin.buffer.read(1024*1024+1)
        require(len(raw)<=1024*1024,'INSTALL_INPUT_SIZE')
        value=json.loads(raw.decode('utf-8-sig'))
        require(isinstance(value,dict) and set(value)=={'operator','instanceId','runtimePassword'},'INSTALL_INPUT_FIELDS')
        parameters=value['operator']
        require(isinstance(parameters,dict) and set(parameters)=={'host','port','dbname','user','password'},'INSTALL_OPERATOR_FIELDS')
        require(type(parameters['port']) is int and 1<=parameters['port']<=65535,'INSTALL_OPERATOR_PORT')
        require(all(isinstance(parameters[k],str) and parameters[k] for k in ('host','dbname','user','password')),'INSTALL_OPERATOR_VALUE')
        result=install(parameters,instance_id=value['instanceId'],runtime_password=value['runtimePassword'])
        print(json.dumps(result,ensure_ascii=False))
        return 0
    except StoreError as error:
        print(json.dumps({'status':'REJECTED','error':str(error)}))
    except Exception:
        # PostgreSQL connection messages and malformed input may carry secrets.
        print(json.dumps({'status':'REJECTED','error':'ORBITA_PG_INSTALL_FAILED'}))
    return 1


if __name__=='__main__':
    raise SystemExit(main())
