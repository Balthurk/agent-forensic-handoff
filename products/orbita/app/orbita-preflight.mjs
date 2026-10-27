#!/usr/bin/env node
// Node >=22. No dependencies. Inspects API status; never starts work or creates a backup.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isId = value => typeof value === 'string' && value.length > 0;
const ROOT = path.dirname(fileURLToPath(import.meta.url));

export function validateBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use only an HTTP loopback origin, e.g. http://127.0.0.1:4475');
  }
  return url.origin;
}

export async function requestJson(base, endpoint, { method = 'GET', body, timeoutMs = 60000 } = {}) {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const metadata = { endpoint, method, startedAt };
  try {
    const response = await fetch(`${validateBase(base)}${endpoint}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    metadata.httpStatus = response.status;
    if (!response.ok) { await response.body?.cancel(); return { ok: false, ...metadata, error: `http_${response.status}` }; }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw new Error('response_too_large');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    metadata.responseBytes = bytes.length;
    metadata.responseSha256 = sha256(bytes);
    let data;
    try { data = JSON.parse(bytes.toString('utf8')); }
    catch { return { ok: false, ...metadata, error: 'invalid_json' }; }
    return { ok: true, ...metadata, durationMs: Math.round(performance.now() - start), data };
  } catch (error) {
    const reason = ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' :
      error.message === 'response_too_large' ? 'response_too_large' : 'connection_or_redirect_error';
    return { ok: false, ...metadata, durationMs: Math.round(performance.now() - start), error: reason };
  }
}

export function validateProvenance(value) {
  if (!isObject(value) || value.schema !== 'orbita-preflight-provenance-1' || !Array.isArray(value.citations) || !value.citations.length) {
    throw new Error('Missing or malformed provenance');
  }
  for (const c of value.citations) {
    if (![c.id, c.conversationId, c.eventId, c.quote, c.interpretation, c.sourceRole].every(isId) || !isHash(c.recordSha256) || !isHash(c.sourceTextSha256)) {
      throw new Error('Malformed provenance citation');
    }
  }
  if (new Set(value.citations.map(c => c.id)).size !== value.citations.length) throw new Error('Duplicate citation id');
  return value;
}

export async function collect({ base = 'http://127.0.0.1:4475', timeoutMs = 60000, provenance }) {
  base = validateBase(base); validateProvenance(provenance);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error('timeout-ms must be 100..120000');
  const startedAt = new Date().toISOString();
  const snapshots = { bootstrapBefore: await requestJson(base, '/api/bootstrap', { timeoutMs }) };
  const routes = [
    ['coverage', '/api/coverage'], ['recovery', '/api/recovery/status'],
    ['pipeline', '/api/pipeline'], ['reevaluation', '/api/reevaluation', { method: 'POST', body: { op: 'status' } }],
  ];
  const evidenceKeys = new Map(provenance.citations.map(c => [`${c.conversationId}:${c.eventId}`, c]));
  for (const [key, c] of evidenceKeys) routes.push([`source:${key}`, `/api/evidence?conversation=${encodeURIComponent(c.conversationId)}&event=${encodeURIComponent(c.eventId)}`]);
  await Promise.all(routes.map(async ([name, endpoint, options]) => {
    snapshots[name] = await requestJson(base, endpoint, { timeoutMs, ...options });
  }));
  snapshots.bootstrapAfter = await requestJson(base, '/api/bootstrap', { timeoutMs });
  return { base, startedAt, finishedAt: new Date().toISOString(), snapshots };
}

export function buildReport(collection, { conversationIds = [], provenance }) {
  validateProvenance(provenance);
  const observations = [], memories = [], recommendations = [];
  const add = (id, status, detail, observed = null, criteria = []) => observations.push({ id, status, detail, observed, criteria });
  const recommend = (text, criteria) => recommendations.push({ text, criteria });
  const snapshots = collection.snapshots;
  const read = (name, predicate) => {
    const s = snapshots[name];
    if (!s?.ok) { add(`endpoint.${name}`, 'unknown', 'No hay una respuesta utilizable de esta API.', { error: s?.error ?? 'missing' }, ['C3']); return null; }
    if (!predicate(s.data)) { add(`endpoint.${name}`, 'unknown', 'Respuesta con estructura ausente o no reconocida.', null, ['C3']); return null; }
    add(`endpoint.${name}`, 'observed', 'Respuesta JSON con la estructura mínima esperada.');
    return s.data;
  };
  const libraryShape = d => isObject(d) && d.application === 'afh-orbita' && Array.isArray(d.library) && d.library.length > 0 && d.library.every(x => isObject(x) && isId(x.id));
  const before = read('bootstrapBefore', libraryShape), after = read('bootstrapAfter', libraryShape);
  const coverage = read('coverage', d => Array.isArray(d) && d.length > 0 && d.every(x => isObject(x) && isId(x.id)));
  const recovery = read('recovery', d => isObject(d) && typeof d.busy === 'boolean');
  const pipeline = read('pipeline', d => isObject(d) && ['pipelines','targets','members','events'].every(k => Array.isArray(d[k])));
  const reevaluation = read('reevaluation', d => isObject(d) && ['watches','jobs','events'].every(k => Array.isArray(d[k])));
  const duplicateIds = rows => new Set(rows.map(x => x.id)).size !== rows.length;
  if (before && after) {
    const signature = rows => JSON.stringify(rows.map(x => [x.id, x.hash, x.verified, x.coverage]).sort((a,b) => a[0].localeCompare(b[0])));
    const stable = !duplicateIds(before.library) && !duplicateIds(after.library) && signature(before.library) === signature(after.library);
    add('library.stability', stable ? 'observed' : 'issue', stable ? 'Mismas identidades, hashes y flags al inicio y al final.' : 'Identidades duplicadas o biblioteca cambiada durante la lectura.', null, ['C2']);
  }
  const selected = [...new Set(conversationIds.length ? conversationIds : before?.library.map(x => x.id) ?? [])];
  if (!selected.length) add('scope', 'unknown', 'No se ha podido establecer ninguna memoria en el alcance.', null, ['C4']);
  if (coverage && duplicateIds(coverage)) add('coverage.duplicates', 'issue', 'La API devuelve identidades de cobertura duplicadas.', null, ['C2']);
  for (const id of selected) {
    const entries = before?.library.filter(x => x.id === id) ?? [];
    const rows = coverage?.filter(x => x.id === id) ?? [];
    if (entries.length !== 1) { add(`${id}.identity`, 'issue', 'Memoria solicitada ausente o ambigua.', { id }, ['C2']); continue; }
    const item = entries[0], c = rows.length === 1 ? rows[0] : null;
    add(`${id}.integrity`, item.verified === true && isHash(item.hash) ? 'observed' : item.verified === false ? 'issue' : 'unknown',
      'Verificación declarada por la API; el cliente no lee los originales del filesystem.', { verified: typeof item.verified === 'boolean' ? item.verified : null, revision: isHash(item.hash) ? item.hash : null }, ['C2','C6']);
    if (!c) { add(`${id}.coverage`, 'unknown', 'Cobertura ausente o ambigua para la memoria.', null, ['C4']); continue; }
    add(`${id}.revision`, isHash(c.revision) && c.revision === item.hash ? 'observed' : 'issue', 'Comparación entre revisión de biblioteca y cobertura.', { library: item.hash, coverage: c.revision }, ['C2']);
    const countNames = ['denominator','archived','parsed','indexedPreview','availableFullText','indexedFullText'];
    const valid = countNames.every(k => isCount(c[k])) && c.denominator > 0 && c.unit === 'source_records' &&
      c.archived <= c.denominator && c.parsed <= c.archived && c.indexedPreview <= c.parsed && c.availableFullText <= c.parsed && c.indexedFullText <= c.availableFullText;
    if (!valid) add(`${id}.counts`, 'unknown', 'Conteos o unidades ausentes, incompatibles o fuera de rango.', null, ['C3','C4']);
    else {
      add(`${id}.records`, c.archived === c.denominator && c.parsed === c.denominator && c.indexedPreview === c.denominator ? 'observed' : 'issue',
        'Archivo, parseo y vista previa del universo de registros declarado.', Object.fromEntries(['unit','denominator','archived','parsed','indexedPreview'].map(k => [k,c[k]])), ['C4']);
      add(`${id}.text`, c.availableFullText > 0 && c.indexedFullText === c.availableFullText ? 'observed' : 'unknown',
        'Texto indexado respecto al texto disponible; este denominador no equivale a todos los registros fuente.', { availableFullText:c.availableFullText, indexedFullText:c.indexedFullText, sourceRecords:c.denominator }, ['C4']);
    }
    const sem = c.semantic;
    const semOk = isObject(sem) && sem.status === 'indexed' && sem.revision === item.hash && isCount(sem.records) && sem.records === c.availableFullText &&
      isCount(sem.sourceCodepoints) && sem.sourceCodepoints > 0 && sem.coveredCodepoints === sem.sourceCodepoints && sem.truncatedChunks === 0;
    add(`${id}.semantic_index`, semOk ? 'observed' : 'unknown', 'Revisión, registros, codepoints y truncamientos declarados del índice; no certifican contenido semántico.',
      { status:sem?.status ?? null, revision:sem?.revision ?? null, records:sem?.records ?? null, sourceCodepoints:sem?.sourceCodepoints ?? null, coveredCodepoints:sem?.coveredCodepoints ?? null, truncatedChunks:sem?.truncatedChunks ?? null }, ['C2','C4']);
    add(`${id}.semantic`, 'unknown', 'Los conteos e índices no prueban suficiencia semántica ni extracción exhaustiva.',
      { indexStatus: typeof c.semantic?.status === 'string' ? c.semantic.status : null, extractionStatus: typeof c.extracted?.status === 'string' ? c.extracted.status : null, completeness: typeof c.extracted?.completeness === 'string' ? c.extracted.completeness : null }, ['C4','C6']);
    memories.push({ id, revision:isHash(item.hash) ? item.hash : null, sourceScope:typeof item.coverage === 'string' ? item.coverage : 'unknown', ...(valid ? { sourceRecords:c.denominator, archived:c.archived, parsed:c.parsed, availableFullText:c.availableFullText, indexedFullText:c.indexedFullText } : {}) });
  }
  if (recovery) {
    add('recovery.busy', recovery.busy ? 'issue' : 'observed', 'Flag busy observado en esta consulta; no prueba exclusión de otros escritores.', { busy:recovery.busy }, ['C2']);
    const r = recovery.restored;
    if (isObject(r)) {
      const identity = isId(r.id) && isId(r.snapshotId) && isHash(r.archiveSha256) && isHash(r.treeHash);
      add('recovery.receipt', identity && r.validation?.originalsVerified === true ? 'observed' : 'unknown',
        'Recibo de restauración declarado por la API; no es una nueva restauración ni un hash independiente del árbol.',
        { id:r.id ?? null, snapshotId:r.snapshotId ?? null, archiveSha256:r.archiveSha256 ?? null, treeHash:r.treeHash ?? null, restoredAt:r.restoredAt ?? null, originalsVerified:r.validation?.originalsVerified ?? null }, ['C2','C6']);
      for (const flag of ['automaticWork','externalAccess']) add(`recovery.${flag}`, r[flag] === false ? 'observed' : r[flag] === true ? 'issue' : 'unknown',
        `Flag ${flag} declarado en el recibo; no demuestra actividad actual fuera de esta API.`, { value:typeof r[flag] === 'boolean' ? r[flag] : null }, ['C2']);
    } else add('recovery.receipt', 'unknown', 'No hay un recibo de restauración reconocible. Puede ser una memoria que no se haya restaurado.', null, ['C2']);
  }
  if (pipeline) add('pipeline.records', pipeline.pipelines.length || pipeline.targets.length || pipeline.members.length ? 'unknown' : 'observed',
    'Inventario registrado en pipeline; una lista vacía no prueba que todos los procesos estén detenidos.',
    { pipelines:pipeline.pipelines.length, targets:pipeline.targets.length, members:pipeline.members.length, events:pipeline.events.length, approval:typeof pipeline.approval === 'string' ? pipeline.approval : null, semanticCompleteness:typeof pipeline.semanticCompleteness === 'string' ? pipeline.semanticCompleteness : null }, ['C1','C6']);
  if (reevaluation) add('reevaluation.records', reevaluation.watches.length || reevaluation.jobs.length ? 'unknown' : 'observed',
    'Inventario registrado de watches/jobs; no se deduce actividad de entradas ni ausencia global de automatismos.',
    { watches:reevaluation.watches.length, jobs:reevaluation.jobs.length, events:reevaluation.events.length, approval:typeof reevaluation.approval === 'string' ? reevaluation.approval : null }, ['C1','C6']);
  for (const c of provenance.citations) {
    const s = snapshots[`source:${c.conversationId}:${c.eventId}`];
    const e = s?.ok ? s.data : null;
    const good = isObject(e) && e.id === c.eventId && e.conversationId === c.conversationId && e.role === c.sourceRole &&
      e.verified === true && e.sha256 === c.recordSha256 && typeof e.raw === 'string' && sha256(e.raw) === c.recordSha256 &&
      typeof e.text === 'string' && sha256(e.text) === c.sourceTextSha256 && e.text.includes(c.quote) && e.identity?.identity_conflict !== true &&
      (!c.sourceConversationId || e.sourceConversationId === c.sourceConversationId) && (!c.nativeEventId || e.identity?.event_id === c.nativeEventId);
    add(`source.${c.id}`, good ? 'observed' : 'unknown', good ? 'Cita, rol e identidad coinciden; SHA-256 calculado sobre el registro original recibido.' : 'No se ha verificado la cita y el registro original esperado.',
      { conversationId:c.conversationId, eventId:c.eventId, role:c.sourceRole, recordSha256:c.recordSha256 }, [c.id]);
  }
  recommend('Resolver primero las observaciones con issue o unknown relacionadas con datos ausentes, revisiones, integridad y fuentes. Repetir la lectura después de corregir su causa.', ['C3']);
  recommend('Antes de respaldar, identificar el corte estable y los escritores, y conservar snapshotId, revisión, hash y límites persistentes. Este cliente no crea el respaldo ni bloquea escritores.', ['C2']);
  recommend('Revisar por separado cobertura semántica, criterios de aceptación y autorización humana para la operación concreta.', ['C1','C4','C5']);
  const unknowns = [
    { id:'human_approval', detail:'La aprobación humana y global no se establece con esta API ni con estados técnicos verdes.', criteria:['C1','C5'] },
    { id:'atomic_snapshot', detail:'Las consultas abarcan un intervalo. La estabilidad de biblioteca no garantiza un corte transaccional ni ausencia de escrituras concurrentes.', criteria:['C2'] },
    { id:'independent_restore', detail:'No se ha creado ni restaurado un respaldo; integridad física actual, persistencia de presupuestos y prueba funcional integral requieren evidencia adicional.', criteria:['C2','C6'] },
    ...observations.filter(x => x.status === 'unknown').map(x => ({ id:x.id, detail:x.detail, criteria:x.criteria })),
  ];
  const counts = Object.fromEntries(['observed','issue','unknown'].map(status => [status, observations.filter(x => x.status === status).length]));
  return {
    schema:'orbita-preflight-report-1', generatedAt:new Date().toISOString(), base:collection.base,
    observationWindow:{ startedAt:collection.startedAt, finishedAt:collection.finishedAt }, selectedConversationIds:selected,
    status:counts.issue || counts.unknown ? 'REVIEW_REQUIRED' : 'OBSERVATIONS_COLLECTED',
    exitCode:counts.issue || counts.unknown ? 2 : 0,
    acceptance:{ human:'unknown', global:'unknown', operationAuthorizedByReport:false },
    counts, memories, observations, unknowns, recommendations,
    interpretations:provenance.citations.map(c => ({ criterion:c.id, text:c.interpretation, status:'agent_interpretation_of_historical_source', sourceRole:c.sourceRole })),
    citations:provenance.citations.map(c => ({ id:c.id, conversationId:c.conversationId, eventId:c.eventId, sourceRole:c.sourceRole, quote:c.quote, recordSha256:c.recordSha256 })),
    requests:Object.entries(snapshots).map(([name,{data,...meta}]) => ({name,...meta})),
  };
}

export function renderMarkdown(report) {
  const clean = value => String(value).replace(/[\r\n|]/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = ['# Comprobación previa de Órbita', '', `Estado: **${report.status}** · ${report.generatedAt}`, '',
    'La aprobación humana y global permanece desconocida. Este informe no autoriza una operación ni acredita aceptación de producto.', '',
    `Alcance: ${report.selectedConversationIds.map(clean).join(', ') || 'desconocido'}.`, '', '## Observaciones', '', '| Comprobación | Estado | Detalle y valor observado |', '|---|---|---|'];
  for (const o of report.observations) lines.push(`| ${clean(o.id)} | ${o.status} | ${clean(o.detail)} ${o.observed ? clean(JSON.stringify(o.observed)) : ''} |`);
  for (const [title, rows] of [['Desconocidos', report.unknowns], ['Recomendaciones', report.recommendations], ['Interpretaciones del agente', report.interpretations]]) {
    lines.push('', `## ${title}`, '');
    for (const row of rows) lines.push(`- ${clean(row.detail ?? row.text)} [${(row.criteria ?? [row.criterion]).join(', ')}]`);
  }
  lines.push('', '## Fuentes verificables', '');
  for (const c of report.citations) lines.push(`- **${c.id}** · ${clean(c.conversationId)} / ${clean(c.eventId)} · rol ${clean(c.sourceRole)} · SHA-256 ${c.recordSha256}`, `  > ${clean(c.quote)}`);
  return lines.join('\n') + '\n';
}

export async function main(argv = process.argv.slice(2)) {
  const options = { base:'http://127.0.0.1:4475', timeoutMs:60000, conversationIds:[] };
  for (let i=0;i<argv.length;i++) {
    const key=argv[i];
    if (key === '--help') { console.log('node orbita-preflight.mjs [--base-url http://127.0.0.1:4475] [--conversation ID] [--timeout-ms 60000] [--json NEW_FILE] [--markdown NEW_FILE]\nExit 0: observaciones recogidas; 2: revisión necesaria; 1: uso/archivo. Ninguno autoriza operar. No sobrescribe archivos.'); return 0; }
    if (!['--base-url','--conversation','--timeout-ms','--json','--markdown'].includes(key) || !argv[i+1] || argv[i+1].startsWith('--')) throw new Error(`Unknown or incomplete argument: ${key}`);
    const value=argv[++i];
    if (key==='--conversation') options.conversationIds.push(value);
    else if (key==='--base-url') options.base=value;
    else if (key==='--timeout-ms') options.timeoutMs=Number(value);
    else options[key.slice(2)]=value;
  }
  validateBase(options.base);
  const provenance=validateProvenance(JSON.parse(await readFile(path.join(ROOT,'provenance.json'),'utf8')));
  const collection=await collect({...options,provenance});
  const report=buildReport(collection,{...options,provenance});
  if (options.json) await writeFile(options.json,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  if (options.markdown) await writeFile(options.markdown,renderMarkdown(report),{flag:'wx'});
  console.log(renderMarkdown(report));
  return report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode=await main(); }
  catch (error) { console.error(`Preflight error: ${error.code === 'EEXIST' ? 'Output file already exists; choose a new name.' : error.message}`); process.exitCode=1; }
}
