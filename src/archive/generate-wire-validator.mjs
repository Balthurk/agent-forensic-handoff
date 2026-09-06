import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import Ajv2020 from '../../tools/specification/node_modules/ajv/dist/2020.js';
import addFormats from '../../tools/specification/node_modules/ajv-formats/dist/index.js';
import standalone from '../../tools/specification/node_modules/ajv/dist/standalone/index.js';
const checkout=fileURLToPath(new URL('../../',import.meta.url)),target=process.argv.includes('--check')?fs.mkdtempSync(path.join(os.tmpdir(),'afh-wire-build-')):path.join(checkout,'src/archive'),deps=path.join(checkout,'tools/specification/node_modules');
const schemaBytes=fs.readFileSync(checkout+'/schemas/archive-v4.schema.json'),schema=JSON.parse(schemaBytes),registry=JSON.parse(fs.readFileSync(checkout+'/specification/contracts.json'));
const ajv=new Ajv2020({allErrors:true,strict:true,code:{source:true,optimize:true,lines:true}});addFormats(ajv);ajv.addSchema(schema);
let code=standalone(ajv,{validateRequest:schema.$id+'#/$defs/Request',validateResponse:schema.$id+'#/$defs/Response'});
const depsMap={'ajv/dist/runtime/ucs2length':'ucs2length','ajv-formats/dist/formats':'formats','ajv/dist/runtime/equal':'equal'};
fs.mkdirSync(target+'/schema-runtime',{recursive:true});
for(const [dependency,name]of Object.entries(depsMap))if(code.includes('require("'+dependency+'")')){
  code=code.replaceAll('require("'+dependency+'")','require("./schema-runtime/'+name+'.cjs")');
  let source=fs.readFileSync(deps+'/'+dependency+'.js','utf8').replace(/^\w+\.code = .*$/gm,'');
  if(name==='equal'){
    const equal=fs.readFileSync(deps+'/fast-deep-equal/index.js','utf8');if(equal.includes('require('))throw new Error('Unbundled equal dependency');
    fs.writeFileSync(target+'/schema-runtime/fast-deep-equal.cjs',equal);source=source.replace('require("fast-deep-equal")','require("./fast-deep-equal.cjs")');
  }
  if(source.includes('require(')&&name!=='equal')throw new Error('Unbundled runtime dependency in '+dependency);
  fs.writeFileSync(target+'/schema-runtime/'+name+'.cjs',source.replace(/^\/\/# sourceMappingURL=.*$/gm,'').trimEnd()+'\n');
}
if([...code.matchAll(/require\("([^"]+)"\)/g)].some(match=>!match[1].startsWith('./schema-runtime/')))throw new Error('External runtime dependency remains');
fs.writeFileSync(target+'/wire-validation.cjs','// Generated from the frozen wire schema using Ajv; do not edit manually.\n'+code);
for(const pkg of ['ajv','ajv-formats','fast-deep-equal'])fs.writeFileSync(target+'/schema-runtime/LICENSE-'+pkg+'.txt',fs.readFileSync(deps+'/'+pkg+'/LICENSE','utf8').trimEnd()+'\n');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(target+'/wire-build.json',JSON.stringify({schema_sha256:sha(schemaBytes),generator:'Ajv2020 standalone',ajv:JSON.parse(fs.readFileSync(deps+'/ajv/package.json')).version,ajv_formats:JSON.parse(fs.readFileSync(deps+'/ajv-formats/package.json')).version,error_catalog:registry.error_catalog.map(({code,status,retryable})=>({code,status,retryable}))},null,2)+'\n');
console.log(JSON.stringify({generated_bytes:Buffer.byteLength(code),schema_sha256:sha(schemaBytes)}));

if(process.argv.includes('--check')){
  const files=['wire-validation.cjs','wire-build.json',...fs.readdirSync(path.join(target,'schema-runtime')).map(name=>'schema-runtime/'+name)];
  const differences=files.filter(file=>!fs.readFileSync(path.join(target,file)).equals(fs.readFileSync(path.join(checkout,'src/archive',file))));
  console.log(JSON.stringify({reproducible:differences.length===0,differences,verification_output:target}));if(differences.length)process.exitCode=1;
}
