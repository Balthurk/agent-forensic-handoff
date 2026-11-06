import path from 'node:path';

export function commonOutputBase({out,caseDir}={}){
  const value=out||(caseDir?path.dirname(path.resolve(caseDir)):process.env.AFH_COSMOS_DATA);
  if(!value)throw Object.assign(new Error('An explicit common root is required: --case-dir, --out or AFH_COSMOS_DATA'),{code:'ORBITA_PG_OUTPUT_ROOT_REQUIRED'});
  return path.resolve(value);
}
