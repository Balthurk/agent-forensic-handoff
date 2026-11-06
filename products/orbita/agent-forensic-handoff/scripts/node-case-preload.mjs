// Explicit per-file qualification scopes. Workers and subprocess helpers retain
// the scope inherited from their test; they are not assigned another workspace.
import fs from 'node:fs';
import path from 'node:path';
import {isMainThread} from 'node:worker_threads';

if(isMainThread&&process.argv[1]&&process.env.ORBITA_TEST_CASE_MAP){
 const index=JSON.parse(fs.readFileSync(process.env.ORBITA_TEST_CASE_MAP,'utf8'));
 const key=path.resolve(process.argv[1]).toLowerCase();
 if(Object.hasOwn(index,key)){
  const value=index[key];
  const allowed=new Set(['ORBITA_POSTGRES_CONFIG','ORBITA_POSTGRES_TEST_ROOT','ORBITA_POSTGRES_TEST_NATIVE_ROOT','ORBITA_POSTGRES_TEST_RECEIPTS','AFH_TEST_ROOT','TEMP','TMP']);
  if(!value||typeof value!=='object'||Object.keys(value).some(k=>!allowed.has(k))||Object.values(value).some(v=>typeof v!=='string'||!path.isAbsolute(v)))throw new Error('PG01_TEST_SCOPE_INVALID');
  if(!value.ORBITA_POSTGRES_CONFIG||!value.ORBITA_POSTGRES_TEST_ROOT||!value.ORBITA_POSTGRES_TEST_RECEIPTS)throw new Error('PG01_TEST_SCOPE_INCOMPLETE');
  delete process.env.ORBITA_POSTGRES_BINDING;
  delete process.env.ORBITA_POSTGRES_TEST_NATIVE_ROOT;
  Object.assign(process.env,value);
 }
}
