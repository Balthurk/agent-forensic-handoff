import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Ajv2020 from '../tools/specification/node_modules/ajv/dist/2020.js';
import addFormats from '../tools/specification/node_modules/ajv-formats/dist/index.js';
import { temporalChecks, validateEvidencePair } from './contract-checks.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function pointer(value, pointerValue) {
  if (pointerValue === '') return value;
  if (!pointerValue.startsWith('/')) throw new Error('Invalid JSON pointer');
  for (const part of pointerValue.slice(1).split('/')) {
    const key = part.replaceAll('~1','/').replaceAll('~0','~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value,key)) throw new Error('Unresolvable JSON pointer '+pointerValue);
    value = value[key];
  }
  return value;
}
function localPath(root, rel) {
  if (path.isAbsolute(rel) || /^[a-z]:/i.test(rel)) throw new Error('Expected repository-relative path: '+rel);
  const full = path.resolve(root,rel);
  if (!full.startsWith(path.resolve(root)+path.sep)) throw new Error('Reference escapes repository: '+rel);
  if (!fs.existsSync(full)) throw new Error('Missing reference: '+rel);
  const real = fs.realpathSync(full);
  if (!real.startsWith(fs.realpathSync(root)+path.sep)) throw new Error('Reference resolves outside repository: '+rel);
  return full;
}
function resolveDoc(root, reference) {
  const [rel, fragment] = reference.split('#');
  const full=localPath(root,rel);
  if (fragment && fragment.startsWith('/')) return pointer(readJson(full),fragment);
  if (fragment) {
    const body=fs.readFileSync(full,'utf8');
    const slug = value => value.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu,'').replaceAll(' ','-');
    if (!body.split(/\r?\n/).filter(l=>/^#+ /.test(l)).some(l=>slug(l.replace(/^#+ /,''))===fragment)) throw new Error('Missing heading: '+reference);
  }
  return fs.readFileSync(full,'utf8');
}
export function assertAcyclic(rows, key, edges, label) {
  const map=new Map(rows.map(r=>[r[key],r])); const done=new Set(); const visiting=new Set();
  const visit=id=>{
    if (!map.has(id)) throw new Error(label+' unknown dependency '+id);
    if(visiting.has(id)) throw new Error(label+' cycle at '+id);
    if(done.has(id)) return;
    visiting.add(id); for(const dep of map.get(id)[edges]) visit(dep); visiting.delete(id);done.add(id);
  };
  for(const id of map.keys())visit(id);
}
function ajvInstance() { const ajv=new Ajv2020({allErrors:true,strict:true,validateFormats:true});addFormats(ajv);return ajv; }
export function validateWire(value, definition, root=ROOT) {
  const schema=readJson(path.join(root,'schemas/archive-v4.schema.json'));
  const ajv=ajvInstance();ajv.addSchema(schema);
  const validator=ajv.compile({$ref:schema.$id+'#/$defs/'+definition});
  return {passed:validator(value),errors:validator.errors??[]};
}
export function relationalWireChecks(value, registry, pair=null) {
  const stack=[[value,0]];
  while(stack.length){const [item,depth]=stack.pop();if(depth>32)return ['JSON_DEPTH_LIMIT'];if(item&&typeof item==='object')for(const child of Object.values(item))if(child&&typeof child==='object')stack.push([child,depth+1]);}
  const problems=temporalChecks(value);
  if(value.kind==='request'){
    if(Buffer.byteLength(JSON.stringify(value),'utf8')>1048576)problems.push('REQUEST_TOO_LARGE');
    if(value.operation==='context.build' && value.params.budget_kind==='tokenizer' && !value.params.tokenizer)problems.push('TOKENIZER_IDENTITY_REQUIRED');
    if(value.operation==='association.record'){
      const ids=value.params.changes.map(x=>x.association_id+'\0'+x.branch_id);
      if(new Set(ids).size!==ids.length)problems.push('DUPLICATE_ASSERTION_IN_BATCH');
    }
  }
  if(value.kind==='progress'){
    if(value.total!==null && BigInt(value.completed)>BigInt(value.total))problems.push('PROGRESS_OVER_TOTAL');
    if((value.eta_status==='UNAVAILABLE')!==(value.eta_ms===null))problems.push('ETA_STATUS_MISMATCH');
    if(value.phase_elapsed_ms>value.elapsed_ms)problems.push('PHASE_EXCEEDS_ELAPSED');
  }
  if(value.kind==='response'){
    if(Buffer.byteLength(JSON.stringify(value),'utf8')>8388608)problems.push('FRAME_TOO_LARGE');
    if(value.error){const error=registry.error_catalog.find(x=>x.code===value.error.code);if(!error||error.status!==value.status||error.retryable!==value.error.retryable)problems.push('ERROR_CATALOG_MISMATCH');}
    const c=value.receipt.coverage;
    if(BigInt(c.records_parsed)+BigInt(c.records_unparsed)!==BigInt(c.records_preserved))problems.push('PARSE_ACCOUNTING');
    if(BigInt(c.records_normalized)+BigInt(c.records_unsupported)!==BigInt(c.records_parsed))problems.push('NORMALIZATION_ACCOUNTING');
    if(BigInt(c.indexed_chunks)>BigInt(c.eligible_chunks))problems.push('SEMANTIC_ACCOUNTING');
    if(value.operation==='evidence.read'&&value.data){const d=value.data;const actual=d.format==='base64'?Buffer.from(d.payload,'base64').length:Buffer.byteLength(d.payload,'utf8');if(d.format==='base64'&&Buffer.from(d.payload,'base64').toString('base64')!==d.payload)problems.push('INVALID_BASE64');if(BigInt(actual)!==BigInt(d.bytes_returned))problems.push('EVIDENCE_LENGTH');if(d.partial!==(d.continuation!==null))problems.push('CONTINUATION_REQUIRED');if(!pair)problems.push('REQUEST_RESPONSE_PAIR_REQUIRED');else problems.push(...validateEvidencePair(pair.request,value,pair.state));}
    if(value.operation==='context.build'&&value.data){const d=value.data;if(d.budget_kind==='tokenizer' && (!d.tokenizer||d.actual_tokens===null||d.actual_tokens>d.budget_tokens))problems.push('TOKENIZER_HARDCAP');if(d.budget_kind==='estimated'&&d.token_estimate>d.budget_tokens)problems.push('ESTIMATE_BUDGET');}
  }
  return problems;
}

export function validateNormativeExamples(root=ROOT){
  const body=fs.readFileSync(path.join(root,'docs/programs/afh-v0.4.0/API-CONTRACT.md'),'utf8');
  const examples=[...body.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  const errors=[];
  if(examples.length===0)errors.push('No normative JSON examples');
  for(const [index,match]of examples.entries())try{const value=JSON.parse(match[1]);const result=validateWire(value,'Request',root);if(!result.passed)throw new Error(JSON.stringify(result.errors));const issues=temporalChecks(value);if(issues.length)throw new Error(issues.join(','));}catch(e){errors.push('example '+index+': '+e.message);}
  return {passed:errors.length===0,count:examples.length,errors};
}
export function validateRegistry(registry,{root=ROOT,checkGenerated=true}={}){
  const errors=[];const check=(name,fn)=>{try{fn();}catch(e){errors.push(name+': '+e.message);}};
  const jsonCache=new Map();const fixtureJson=file=>{if(!jsonCache.has(file))jsonCache.set(file,readJson(file));return jsonCache.get(file);};
  check('registry-schema',()=>{const ajv=ajvInstance();const v=ajv.compile(readJson(path.join(root,'specification/contracts.schema.json')));if(!v(registry))throw new Error(ajv.errorsText(v.errors,{separator:'; '}));});
  if(errors.length)return {passed:false,errors};
  check('required-artifacts',()=>{for(const rel of ['.gitattributes','.github/workflows/ci.yml','openspec/config.yaml','openspec/specs/legacy-case-access/spec.md','docs/programs/afh-v0.4.0/HANDOFF.md','docs/programs/afh-v0.4.0/TESTING.md','specification/contract-checks.mjs','specification/validate-package.test.mjs','specification/regression-probes.mjs','tools/specification/package-lock.json'])localPath(root,rel);});
  check('generated-view-list',()=>{if(canonical([...registry.program.generated_views].sort())!==canonical(['RECOMMENDATIONS.md','REQUIREMENTS.md','REVIEW-CHECKLIST.md'].sort()))throw new Error('declared generated views differ from renderer');});
  const maps={};
  for(const name of ['profiles','sources','recommendations','changes','requirements','scenarios'])check('unique-'+name,()=>{maps[name]=new Map();for(const row of registry[name]){if(maps[name].has(row.id))throw new Error(row.id);maps[name].set(row.id,row);}});
  check('unique-error-codes',()=>{if(new Set(registry.error_catalog.map(x=>x.code)).size!==registry.error_catalog.length)throw new Error('duplicate error code');});
  check('dependencies',()=>assertAcyclic(registry.changes,'id','depends_on','change'));
  check('inheritance',()=>assertAcyclic(registry.profiles,'id','extends','profile'));
  check('sequence',()=>{const orders=registry.changes.map(x=>x.order).sort((a,b)=>a-b);if(orders.join(',')!==Array.from({length:14},(_,i)=>i+1).join(','))throw new Error('Orders must be exactly 1..14');for(const c of registry.changes)for(const dep of c.depends_on)if(maps.changes.get(dep)?.order>=c.order)throw new Error('Dependency after consumer');});
  check('wire-schema',()=>{ajvInstance().compile(readJson(path.join(root,'schemas/archive-v4.schema.json')));});
  check('normative-examples',()=>{const v=validateNormativeExamples(root);if(!v.passed)throw new Error(v.errors.join('; '));});
  check('tool-versions',()=>{const p=readJson(path.join(root,'tools/specification/package.json'));if(p.devDependencies['@fission-ai/openspec']!==registry.program.openspec_version)throw new Error('OpenSpec version mismatch');const wire=readJson(path.join(root,'schemas/archive-v4.schema.json'));const schemaErrors=wire.$defs.Error.properties.code.enum.slice().sort();if(canonical(schemaErrors)!==canonical(registry.error_catalog.map(x=>x.code).sort()))throw new Error('Wire error enum differs from canonical catalog');});
  const docRefs=new Set();
  for(const source of registry.sources)docRefs.add(source.ref);
  for(const profile of registry.profiles)for(const ref of profile.contract_refs)docRefs.add(ref);
  for(const change of registry.changes)check(change.id,()=>{
    for(const p of change.profiles)if(!maps.profiles.has(p))throw new Error('unknown profile '+p);
    if(!registry.requirements.some(r=>r.change_id===change.id))throw new Error('no requirements');
    for(const area of change.write_set)if(path.isAbsolute(area)||area.includes('..'))throw new Error('invalid public write set');
  });
  for(const req of registry.requirements)check(req.id,()=>{
    if(!maps.changes.has(req.change_id))throw new Error('unknown change');
    if(!/\b(SHALL|MUST)\b/.test(req.statement))throw new Error('requirement lacks normative SHALL/MUST');
    for(const src of req.source_refs)if(!maps.sources.has(src))throw new Error('unknown source '+src);
    for(const s of req.scenario_ids){const sc=maps.scenarios.get(s);if(!sc||sc.change_id!==req.change_id||!sc.requirement_ids.includes(req.id))throw new Error('scenario reverse link '+s);}
  });
  const requiredForProfile=(id,seen=new Set())=>{if(seen.has(id))return [];seen.add(id);const p=maps.profiles.get(id);return p?[...p.required_checks,...p.extends.flatMap(x=>requiredForProfile(x,seen))]:[];};
  for(const sc of registry.scenarios)check(sc.id,()=>{
    const change=maps.changes.get(sc.change_id);if(!change)throw new Error('unknown change');
    if(!maps.sources.has(sc.source_ref))throw new Error('unknown source');
    for(const reqId of sc.requirement_ids){const req=maps.requirements.get(reqId);if(!req||req.change_id!==sc.change_id||!req.scenario_ids.includes(sc.id))throw new Error('requirement reverse link');}
    for(const p of change.profiles)for(const needed of requiredForProfile(p))if(!sc.required_checks.includes(needed))throw new Error('missing inherited check '+needed);
    for(const pair of sc.paired_with)if(!maps.scenarios.has(pair)||pair===sc.id||!maps.scenarios.get(pair).paired_with.includes(sc.id))throw new Error('invalid or asymmetric paired scenario');
    for(const f of [sc.fixture_ref,sc.oracle_ref]){const val=pointer(fixtureJson(localPath(root,f.path)),f.pointer);if(digest(val)!==f.sha256)throw new Error('stale fixture/oracle digest '+f.pointer);}
    const fixture=pointer(fixtureJson(localPath(root,sc.fixture_ref.path)),sc.fixture_ref.pointer);
    if(!fixture.input||!fixture.steps?.length||!fixture.driver_contract)throw new Error('fixture missing concrete input/steps/driver');
    if(fixture.dataset_ref){const dataset=pointer(fixtureJson(localPath(root,sc.fixture_ref.path)),fixture.dataset_ref);if(digest(dataset)!==fixture.dataset_sha256)throw new Error('stale dataset digest');}
    const oracle=pointer(fixtureJson(localPath(root,sc.oracle_ref.path)),sc.oracle_ref.pointer);
    if(!oracle.assertions?.length||!oracle.loss_guards?.length)throw new Error('empty oracle or missing loss guards');
    if(!oracle.expected||!Object.keys(oracle.expected).length)throw new Error('empty expected oracle');
    if(oracle.expected.error&&!registry.error_catalog.some(e=>e.code===oracle.expected.error))throw new Error('oracle error not in catalog');
    if(sc.evidence_kind==='SYNTHETIC_REAL_MODEL'&&!sc.required_checks.includes('REAL_MODEL_IDENTITY'))throw new Error('missing real model check');
    if(sc.phase==='OBSERVED_RED'&&sc.entrypoint.availability!=='EXECUTABLE')throw new Error('RED without executable probe');
    for(const ref of sc.contract_refs)docRefs.add(ref);
    if(sc.entrypoint.availability==='EXECUTABLE'){
      const entry=sc.entrypoint.args.find(x=>/\.(mjs|js)$/.test(x));if(!entry)throw new Error('missing executable script');localPath(root,entry);
      if(!fs.readFileSync(localPath(root,entry),'utf8').includes(sc.id))throw new Error('executable does not name scenario');
    }
  });
  for(const rec of registry.recommendations)check(rec.id,()=>{
    if((rec.id==='N01')!==(rec.origin==='NEW_INFERENCE'))throw new Error('historical attribution mismatch');
    for(const r of rec.requirement_ids)if(!maps.requirements.has(r))throw new Error('unknown requirement '+r);
  });
  for(const src of registry.sources)check('source-coverage-'+src.id,()=>{if(!registry.requirements.some(r=>r.source_refs.includes(src.id)))throw new Error('source clause uncovered');});
  for(const ref of docRefs)check('reference-'+ref,()=>resolveDoc(root,ref));
  if(checkGenerated)for(const [file,body] of generatedFiles(registry))check('generated-'+file,()=>{const full=localPath(root,file);if(fs.readFileSync(full,'utf8')!==body)throw new Error('view differs from canonical registry; run --generate explicitly');});
  return {passed:errors.length===0,errors,counts:{recommendations:registry.recommendations.length,changes:registry.changes.length,requirements:registry.requirements.length,scenarios:registry.scenarios.length,sources:registry.sources.length}};
}

export function generatedFiles(r){
  const files=new Map();const base='docs/programs/afh-v0.4.0/';
  const header=title=>'# '+title+'\n\nGenerated from specification/contracts.json by validate-package.mjs --generate. Edit the canonical registry, not this view.\n\n';
  const esc=s=>s.replaceAll('|','\\|').replaceAll('\n',' ');
  files.set(base+'RECOMMENDATIONS.md',header('Cobertura de las 22 recomendaciones')+'| ID | Origen | Decisión | Justificación | Requisitos y tests |\n|---|---|---|---|---|\n'+r.recommendations.map(x=>`| ${x.id} | ${x.origin} | ${x.decision} | ${esc(x.title+' — '+x.rationale)} | ${x.requirement_ids.join(', ')}; ${r.scenarios.filter(s=>s.requirement_ids.some(id=>x.requirement_ids.includes(id))).map(s=>s.id).join(', ')} |`).join('\n')+'\n');
  files.set(base+'REQUIREMENTS.md',header('Matriz completa de requisitos y escenarios')+'## Cláusulas de origen\n\n| ID | Tipo | Cláusula | Requisitos |\n|---|---|---|---|\n'+r.sources.map(x=>`| ${x.id} | ${x.kind} | ${esc(x.description)} | ${r.requirements.filter(q=>q.source_refs.includes(x.id)).map(q=>q.id).join(', ')} |`).join('\n')+'\n\n## Requisito → escenario → evidencia\n\n| Requisito | Cambio | Contrato | Tests | Evidencia exigida |\n|---|---|---|---|---|\n'+r.requirements.map(q=>`| ${q.id} | ${q.change_id} | ${esc(q.statement)} | ${q.scenario_ids.join(', ')} | ${[...new Set(r.scenarios.filter(s=>q.scenario_ids.includes(s.id)).map(s=>s.evidence_kind))].join(', ')} |`).join('\n')+'\n');
  files.set(base+'REVIEW-CHECKLIST.md',header('Revisión de coordinador y gates')+'## Comprobaciones automatizables\n\n- [ ] validate-package pasó sobre el digest exacto, sin referencias vacías, rotas o cíclicas.\n- [ ] OpenSpec 1.12.0 validate --all --strict pasó para todos los cambios y baseline.\n- [ ] Schemas v4 y registry, oráculos negativos, clasificación de evidencia y tests del gate pasaron.\n- [ ] Runtime/producto intacto en fase de especificación; datos públicos sintéticos y revisados.\n\n## Revisión semántica requerida\n\n- [ ] Cada requisito tiene propósito, contrato y oráculo falsable que conserva información en negativos.\n- [ ] Revisar el programa completo: R1 segmentos temporales; R2 protocolo/frame/presupuesto; R3 registro; R4 probes; R5 ownership; R6 gates y autorización persistente.\n- [ ] Confirmar las 22 decisiones y que ninguna capacidad pendiente se omitió por esfuerzo o prioridad.\n- [ ] Confirmar blind trials con independencia real, límites de cobertura y criterios medidos de release.\n- [ ] Emitir review_ref con snapshot_sha256, reviewer, source_ref resoluble, resultado SATISFACTORY o CHANGES_REQUESTED, findings y hora observada.\n\n## Secuencia y entrada por cambio\n\n| Cambio | Predecesores semánticos | Write set | Pruebas |\n|---|---|---|---|\n'+r.changes.map(c=>`| ${c.id} | ${c.depends_on.join(', ')||'ninguno'} | ${c.write_set.join(', ')} | ${r.scenarios.filter(s=>s.change_id===c.id).map(s=>s.id).join(', ')} |`).join('\n')+'\n\nSPECIFICATION_READY exige revisión semántica satisfactoria del paquete exacto. READY_FOR_COORDINATOR_REVIEW es solo entrega pendiente de esa revisión. IMPLEMENTATION_READY(01) no exige 14 GREEN; exige el paquete completo revisado y sus propios predecesores. Autorización de alcance persiste entre ediciones ordinarias: cambiar digest invalida evidencia/review afectada, no exige otra aprobación humana por sí mismo. PAUSED/revocación sí bloquean. Ver TESTING.md y la función evaluateGate.\n');
  for(const c of r.changes){
    const dir=`openspec/changes/${c.id}/`;const qs=r.requirements.filter(q=>q.change_id===c.id);const ss=r.scenarios.filter(s=>s.change_id===c.id);
    files.set(dir+'.openspec.yaml','schema: spec-driven\n');
    files.set(dir+'proposal.md',`## Why\n\n${c.problem}\n\n${c.benefit}\n\n## What Changes\n\n${c.purpose}\n\n## Capabilities\n\n### New Capabilities\n\n- \`${c.capability}\`: ${c.purpose}\n\n### Modified Capabilities\n\nNo existing OpenSpec requirement is removed; legacy behavior remains covered by legacy-case-access. Fixes apply to new captures.\n\n## Impact\n\nInterfaces: ${c.interfaces.join(', ')}. Write set: ${c.write_set.join(', ')}. Dependencies: ${c.depends_on.join(', ')||'none'}. All shared profiles are normative: ${c.profiles.join(', ')}.\n`);
    files.set(dir+`specs/${c.capability}/spec.md`,`## Purpose\n\n${c.purpose}\n\n## ADDED Requirements\n\n`+qs.map(q=>`### Requirement: ${q.id} ${q.title}\n\n${q.statement}\n\n`+q.scenario_ids.map(id=>{const s=ss.find(x=>x.id===id);return `#### Scenario: ${s.id} ${s.title}\n- **GIVEN** ${s.given}\n- **WHEN** ${s.when}\n- **THEN** ${s.then}\n- **AND** test contract: specification/contracts.json scenario ${s.id}; oracle ${s.oracle_ref.path}#${s.oracle_ref.pointer}.\n`;}).join('\n')).join('\n'));
    files.set(dir+'design.md',`## Context\n\n${c.problem}\n\nPurpose and global integration: ${c.purpose}\n\n## Goals / Non-Goals\n\nBenefit: ${c.benefit}\n\nThis change implements only the declared interfaces and write set. No historical command execution, old-case mutation, global install, or cross-project writes.\n\n## Definitions and shared contracts\n\nGLOSSARY.md, ARCHITECTURE.md, DATA-CONTRACT.md, API-CONTRACT.md and OPERATIONS.md under docs/programs/afh-v0.4.0 are normative. Profile inheritance: ${c.profiles.join(', ')}; resolve in specification/contracts.json. Fact, claim, occurrence, representation, intent, authority, evidence, validity, promotion and closure retain those definitions.\n\n## Decisions\n\n### Algorithm and interface\n\n${c.design.algorithm}\n\nInterfaces: ${c.interfaces.join(', ')}. Exact typed producer/consumer schemas are schemas/archive-v4.schema.json; relational checks remain mandatory.\n\n### Rationale and alternatives\n\n${c.design.rationale}\n\n${c.design.alternatives}\n\n### Persistence, concurrency and idempotence\n\n${c.design.persistence}\n\n### Integration and dependencies\n\n${c.design.integration}\n\nDependencies: ${c.depends_on.join(', ')||'none'}. One writer executes the full ordered program.\n\n## Migration Plan\n\n${c.design.compatibility}\n\n${c.design.recovery}\n\nExpected write set: ${c.write_set.join(', ')}.\n\n## Risks / Trade-offs\n\n${c.design.risks}\n\n## Entry and exit\n\nEntry:\n${c.entry_criteria.map(x=>'- '+x).join('\n')}\n\nExit:\n${c.exit_criteria.map(x=>'- '+x).join('\n')}\n\n## TDD contracts\n\n${ss.length} scenarios in specification/contracts.json. Each names fixture/digest, preconditions, exact command, oracle and evidence class. API absence is NOT_IMPLEMENTED; syntax/import/environment failure is mechanical, never behavioral RED. Existing baseline green tests stay green. Follow TESTING.md to materialize any CONTRACT_ONLY harness before production edits; changing that harness must not weaken the frozen oracle.\n`);
    const tasks=['## 1. Entry and RED','',`- [ ] 1.1 Run IMPLEMENTATION_READY for ${c.id} against current package/review/authorization; retain gate receipt and exact writer/write set.`,`- [ ] 1.2 Materialize the concrete contracts ${ss.map(x=>x.id).join(', ')} as test/acceptance/afh-${String(c.order).padStart(2,'0')}.test.mjs; validate fixtures/digests and capture baseline before product edits.`,`- [ ] 1.3 Execute node --test test/acceptance/afh-${String(c.order).padStart(2,'0')}.test.mjs; retain behavioral RED, NOT_IMPLEMENTED and mechanical failures separately, including positive preservation guards.`,'','## 2. Minimal GREEN',''];
    qs.forEach((q,i)=>tasks.push(`- [ ] 2.${i+1} Implement ${q.id} only within the declared write set; verify ${q.scenario_ids.join(', ')} with the frozen fixture/oracle and retain actual output/evidence.`));
    tasks.push('','## 3. Refactor, integration and exit','',`- [ ] 3.1 Refactor only after GREEN; rerun this change's ${ss.length} scenarios and applicable prior changes without weakening oracles.`,`- [ ] 3.2 Run npm run check and node specification/validate-package.mjs; verify runtime evidence, source immutability, schema/CLI compatibility and all profile checks.`,`- [ ] 3.3 Obtain per-change semantic review and acceptance receipt bound to product candidate and test inputs; mark GREEN only when every required experiment ran, no mechanical or unavailable evidence substituted.`,`- [ ] 3.4 Commit the bounded change with evidence pointers; update the append-only program trace and exact next-change gate. Archive this OpenSpec delta only after task completion and acceptance; no release until 14 completes.`, '');
    files.set(dir+'tasks.md',tasks.join('\n'));
  }
  return files;
}

export function packageSnapshot(root=ROOT){
  const entries=[];
  const paths=['specification','schemas/archive-v4.schema.json','docs/programs/afh-v0.4.0','openspec','tools/specification/package.json','tools/specification/package-lock.json','.github/workflows/ci.yml','.gitignore','.gitattributes'];
  const visit=rel=>{const full=path.join(root,rel);if(!fs.existsSync(full))return;if(fs.lstatSync(full).isSymbolicLink())throw new Error('Symlink in package snapshot');if(fs.statSync(full).isDirectory()){for(const child of fs.readdirSync(full).sort())if(child!=='results'&&child!=='node_modules')visit(rel+'/'+child);}else entries.push({path:rel.replaceAll('\\','/'),sha256:digest(fs.readFileSync(full))});};
  for(const p of paths)visit(p);entries.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  return {sha256:digest(entries),files:entries};
}
export function evaluateGate({registry,validation,snapshot_sha256,context,change_id=null}){
  const blockers=[];
  if(context.phase==='PAUSED'||context.paused===true)blockers.push('PAUSED');
  if(!validation.passed||registry.changes.length!==14||registry.recommendations.length!==22||registry.scenarios.length<200)blockers.push('PACKAGE_INCOMPLETE_OR_INVALID');
  const auth=context.authorization_ref;
  if(!auth||auth.status!=='ACTIVE'||!auth.source_ref||!auth.scope?.includes('afh-v0.4.0'))blockers.push('AUTHORIZATION_SCOPE');
  // Authorization is intentionally not invalidated by a package digest change.
  const review=context.review_ref;
  if(!review||review.result!=='SATISFACTORY'||review.snapshot_sha256!==snapshot_sha256||!review.source_ref||!review.reviewer||review.material_findings!==0)blockers.push('SEMANTIC_REVIEW_PENDING_OR_STALE');
  for(const check of ['openspec','schema','package_tests','traceability','oracle_review']){
    const e=context.evidence?.find(x=>x.check===check);
    if(!e||e.result!=='PASS'||e.snapshot_sha256!==snapshot_sha256||!e.source_ref||e.mechanical_errors!==0)blockers.push('EVIDENCE_'+check.toUpperCase());
    if(e?.claims_real_runtime&&e.runtime_class!=='REAL_AFH')blockers.push('FIXTURE_AS_REAL');
    if(e?.requires_real_model&&e.provider_class!=='REAL_LOCAL')blockers.push('FIXTURE_AS_REAL_MODEL');
  }
  if(change_id){
    const change=registry.changes.find(c=>c.id===change_id);
    if(!change)blockers.push('UNKNOWN_CHANGE');
    if(!context.writer||context.writer.exclusive!==true||!context.writer.task_id||canonical(context.writer.write_set)!==canonical(change?.write_set??[]))blockers.push('WRITER_OR_WRITE_SET');
    const prior=registry.changes.filter(c=>c.order<(change?.order??0));
    for(const dep of prior){const receipt=context.predecessors?.find(p=>p.change_id===dep.id);if(!receipt||receipt.status!=='GREEN'||receipt.package_sha256!==snapshot_sha256||!receipt.candidate_commit||!receipt.evidence_ref||receipt.mechanical_errors!==0||receipt.required_tests_passed!==true)blockers.push('PREDECESSOR_'+dep.id);}
  }
  return {state:blockers.length?'BLOCKED':change_id?'IMPLEMENTATION_READY':'SPECIFICATION_READY',change_id,snapshot_sha256,blockers:[...new Set(blockers)],product_acceptance:'NOT_IMPLIED',dispatch:'NOT_PERFORMED'};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);const registry=readJson(path.join(ROOT,'specification/contracts.json'));
  if(args.includes('--generate')){const v=validateRegistry(registry,{checkGenerated:false});if(!v.passed){console.error(JSON.stringify(v,null,2));process.exitCode=1;}else{for(const [file,body]of generatedFiles(registry)){fs.mkdirSync(path.dirname(path.join(ROOT,file)),{recursive:true});fs.writeFileSync(path.join(ROOT,file),body);}console.log(JSON.stringify({status:'GENERATED',files:generatedFiles(registry).size}));}}
  else{
    const validation=validateRegistry(registry);const snapshot=packageSnapshot();
    const result={kind:'SPECIFICATION_VALIDATION',generated_at:new Date().toISOString(),...validation,snapshot_sha256:snapshot.sha256,product_acceptance:'NOT_IMPLEMENTED',state:validation.passed?'READY_FOR_SEMANTIC_REVIEW_CHECK':'INVALID',node:process.version,head:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim()};
    const gateIndex=args.indexOf('--gate-context');
    if(gateIndex>=0){const ci=args.indexOf('--change');result.gate=evaluateGate({registry,validation,snapshot_sha256:snapshot.sha256,context:readJson(path.resolve(args[gateIndex+1])),change_id:ci>=0?args[ci+1]:null});}
    const outIndex=args.indexOf('--out');if(outIndex>=0){const file=path.resolve(args[outIndex+1]);fs.writeFileSync(file,JSON.stringify(result,null,2)+'\n',{flag:'wx'});}
    console.log(JSON.stringify(result,null,2));process.exitCode=validation.passed&&(!result.gate||result.gate.blockers.length===0)?0:1;
  }
}
