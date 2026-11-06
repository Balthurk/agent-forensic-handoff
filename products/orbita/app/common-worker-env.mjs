// Explicit worker runtime inputs. No inherited operator/provider credentials,
// test hooks, preload flags or sibling/parent database capabilities.
import {fileURLToPath} from 'node:url';
export function commonWorkerEnv(configuration,{data,ownerId}={}){
 const allowed=new Set(['path','systemroot','windir','comspec','temp','tmp']);
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>allowed.has(key.toLowerCase())));
 Object.assign(env,{PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',
  ORBITA_POSTGRES_PYTHON:process.env.ORBITA_POSTGRES_PYTHON,
  AFH_PYTHON:process.env.ORBITA_POSTGRES_PYTHON,
  AFH_MODEL_HOME:process.env.AFH_MODEL_HOME||fileURLToPath(new URL('../runtime/models/',import.meta.url)),
  AFH_COSMOS_EMPTY_LIBRARY:'1',AFH_COSMOS_DATA:data,
  ORBITA_POSTGRES_OWNER_ID:ownerId,ORBITA_POSTGRES_BINDING:JSON.stringify(configuration)});
 return Object.fromEntries(Object.entries(env).filter(([,value])=>value!==undefined));
}
