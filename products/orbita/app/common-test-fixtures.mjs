// Explicit synthetic native inputs/exports and minimal subprocess credentials.
// This module is used by qualification tests, never by a product entrypoint.
import native from 'node:fs';
import path from 'node:path';
export function nativeFixture(prefix){
 if(!process.env.ORBITA_POSTGRES_TEST_RECEIPTS||!/^[a-z0-9-]+$/.test(prefix))throw new Error('EXPLICIT_TEST_RECEIPT_ROOT_REQUIRED');
 return native.mkdtempSync(path.join(process.env.ORBITA_POSTGRES_TEST_RECEIPTS,prefix+'-'));
}
export function runtimeEnv({configuration,data,crashAt}={}){
 const allowed=new Set(['path','systemroot','windir','comspec','temp','tmp']);
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>allowed.has(key.toLowerCase())));
 Object.assign(env,{PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',ORBITA_POSTGRES_PYTHON:process.env.ORBITA_POSTGRES_PYTHON,AFH_PYTHON:process.env.ORBITA_POSTGRES_PYTHON,AFH_MODEL_HOME:process.env.AFH_MODEL_HOME,AFH_COSMOS_EMPTY_LIBRARY:'1'});
 if(configuration)env.ORBITA_POSTGRES_BINDING=JSON.stringify(configuration);
 else if(process.env.ORBITA_POSTGRES_BINDING)env.ORBITA_POSTGRES_BINDING=process.env.ORBITA_POSTGRES_BINDING;
 else env.ORBITA_POSTGRES_CONFIG=process.env.ORBITA_POSTGRES_CONFIG;
 if(data)env.AFH_COSMOS_DATA=data;if(crashAt)env.AFH_CRASH_AT=crashAt;
 return Object.fromEntries(Object.entries(env).filter(([,value])=>value!==undefined));
}
