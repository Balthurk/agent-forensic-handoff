import {canonicalIdentityJson} from './identity.js';

const MAX_REVISIONS = 100000;
const MAX_BYTES = 8 * 1024 * 1024;
const revisionKeys = ['assertion_id','subject_id','branch_id','revision_id','revision_no','recorded_seq','recorded_at','supersedes_revision_id','valid_from','valid_to','provenance','scope'];
function fail(code, message) { throw Object.assign(new Error(message), {code}); }
const invalid = message => fail('INVALID_REQUEST', message);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const count = value => (Number.isSafeInteger(value) && value >= 0) || (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value));
function closed(value, keys, code = 'INVALID_REQUEST') {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    fail(code, 'Temporal input does not match its closed object contract');
  }
}

// Guard before canonicalization: accessors/cycles are not captured JSON and must
// never execute. Bounded traversal also prevents recursive validation overflow.
function boundedJson(value) {
  const ancestors = new Set(); let units = 0, bytes = 0;
  function visit(item, depth) {
    if (++units > 1048576 || depth > 32) fail('LIMIT_EXCEEDED', 'Temporal JSON traversal exceeds bounded work');
    if (typeof item === 'string') { bytes += Buffer.byteLength(item); if (bytes > MAX_BYTES) fail('LIMIT_EXCEEDED', 'Temporal JSON exceeds eight MiB'); return; }
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) invalid('Temporal JSON number must be finite and exact'); return; }
    if (!item || typeof item !== 'object' || ancestors.has(item)) invalid('Temporal input must be acyclic JSON');
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) invalid('Temporal input must be plain JSON');
    const keys = Reflect.ownKeys(item);
    if (keys.some(key => typeof key !== 'string')) invalid('Temporal JSON cannot contain symbol keys');
    if (Array.isArray(item) && (keys.length !== item.length + 1 || Object.keys(item).length !== item.length)) invalid('Temporal arrays must be dense JSON');
    ancestors.add(item);
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length') continue;
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!Object.hasOwn(property, 'value') || !property.enumerable) invalid('Temporal JSON cannot contain accessors or hidden fields');
      bytes += Buffer.byteLength(key); visit(property.value, depth + 1);
    }
    ancestors.delete(item);
  }
  visit(value, 0);
  const encoded = canonicalIdentityJson(value);
  if (Buffer.byteLength(encoded) > MAX_BYTES) fail('LIMIT_EXCEEDED', 'Temporal JSON exceeds eight MiB');
}

function instant(value, code) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) fail(code, 'Temporal instant requires supported RFC3339 precision and an explicit offset');
  const [,year,month,day,hour,minute,second,fraction = '',zone] = match;
  if (+month < 1 || +month > 12 || +day < 1 || +hour > 23 || +minute > 59 || +second > 59 || zone === '-00:00') fail(code, 'Temporal instant has an invalid calendar, leap second or unknown offset');
  const date = new Date(0);
  date.setUTCFullYear(+year, +month - 1, +day); date.setUTCHours(+hour, +minute, +second, 0);
  if (date.getUTCFullYear() !== +year || date.getUTCMonth() !== +month - 1 || date.getUTCDate() !== +day) fail(code, 'Temporal instant has an invalid calendar date');
  let offset = 0;
  if (!/^[Zz]$/.test(zone)) {
    const hours = +zone.slice(1, 3), minutes = +zone.slice(4, 6);
    if (hours > 23 || minutes > 59) fail(code, 'Temporal offset is invalid');
    offset = (zone[0] === '-' ? -1 : 1) * (hours * 60 + minutes);
  }
  return BigInt(date.valueOf() - offset * 60000) * 1000000n + BigInt(fraction.padEnd(9, '0'));
}

function bound(value, start) {
  closed(value, ['kind','value','precision','timezone']);
  if (!['ns','ms','s','day','order_only'].includes(value.precision) || !(value.timezone === null || typeof value.timezone === 'string' && value.timezone.length)) invalid('Temporal bound precision or timezone is invalid');
  if (value.kind === 'known') {
    if (value.precision === 'order_only' || value.timezone === null) invalid('Known bound requires precision and timezone');
    return instant(value.value, 'INVALID_REQUEST');
  }
  if (!['unknown','unbounded',...(start ? [] : ['open'])].includes(value.kind) || value.value !== null) invalid('Temporal bound kind/value is invalid');
  return null;
}

function validateRevision(revision) {
  closed(revision, revisionKeys);
  if (!['assertion_id','subject_id','branch_id','revision_id'].every(key => id(revision[key])) ||
      !['revision_no','recorded_seq'].every(key => Number.isSafeInteger(revision[key]) && revision[key] >= 1) ||
      !(revision.supersedes_revision_id === null || id(revision.supersedes_revision_id))) invalid('Temporal revision identity or sequence is invalid');
  const recorded = instant(revision.recorded_at, 'INVALID_REQUEST'), from = bound(revision.valid_from, true), to = bound(revision.valid_to, false);
  if (from !== null && to !== null && from >= to) fail('INVALID_TEMPORAL_RANGE', 'Temporal validity must be a nonempty half-open interval');
  const provenance = revision.provenance;
  closed(provenance, ['evidence_refs','epistemic','rule_id','rule_version','source_independence_ids','authority_origin','transformation']);
  if (!Array.isArray(provenance.evidence_refs) || !provenance.evidence_refs.length || provenance.evidence_refs.length > 1000000 ||
      !['DIRECT_EVIDENCE','CORROBORATED','INFERRED','UNCERTAIN','CONTRADICTED','UNAVAILABLE'].includes(provenance.epistemic) ||
      !id(provenance.rule_id) || !id(provenance.rule_version) || !Array.isArray(provenance.source_independence_ids) ||
      provenance.source_independence_ids.length > 1000000 || !provenance.source_independence_ids.every(id) ||
      !['DIRECT_HUMAN','TRANSMITTED_HUMAN','AGENT_ATTRIBUTED','HARNESS','UNKNOWN'].includes(provenance.authority_origin) ||
      !['LITERAL','EXTRACTED','INTERPRETED'].includes(provenance.transformation)) invalid('Temporal provenance is malformed');
  for (const ref of provenance.evidence_refs) {
    closed(ref, ['uri','source_revision_id','record_ordinal','byte_offset','byte_length','record_sha256','json_pointer','availability']);
    if (typeof ref.uri !== 'string' || !ref.uri.length || !id(ref.source_revision_id) ||
        !['record_ordinal','byte_offset','byte_length'].every(key => count(ref[key])) ||
        typeof ref.record_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(ref.record_sha256) || typeof ref.json_pointer !== 'string' ||
        !['AVAILABLE','MISSING','TRUNCATED_AT_SOURCE','REDACTED_DERIVATIVE_ONLY','UNSUPPORTED_ENCODING'].includes(ref.availability)) invalid('Temporal evidence reference is malformed');
  }
  closed(revision.scope, ['project_id','session_ids','group_id','association_mode']);
  if (!(revision.scope.project_id === null || id(revision.scope.project_id)) || !(revision.scope.group_id === null || id(revision.scope.group_id)) ||
      !Array.isArray(revision.scope.session_ids) || revision.scope.session_ids.length > 256 || !revision.scope.session_ids.every(id) ||
      !['observed','include_inferred'].includes(revision.scope.association_mode)) invalid('Temporal scope is malformed');
  return {revision, recorded, from, to};
}

/** Pure selection over caller-acquired revisions; it does not establish evidence authenticity. */
export function selectTemporal(revisions, selection) {
  if (!Array.isArray(revisions)) invalid('Temporal revisions must be an array');
  if (revisions.length > MAX_REVISIONS) fail('LIMIT_EXCEEDED', 'Temporal revision count exceeds the bounded selector limit');
  closed(selection, ['published_seq','known_at','valid_at','include_uncertain'], 'INVALID_QUERY');
  if (!Number.isSafeInteger(selection.published_seq) || selection.published_seq < 0 || typeof selection.include_uncertain !== 'boolean') fail('INVALID_QUERY', 'Temporal cut or uncertainty flag is invalid');
  const known = instant(selection.known_at, 'INVALID_QUERY'), valid = instant(selection.valid_at, 'INVALID_QUERY');
  boundedJson(revisions);
  const byId = new Map(), groups = new Map(), assertionSubjects = new Map();
  for (const revision of revisions) {
    const row = validateRevision(revision);
    if (revision.recorded_seq > selection.published_seq || row.recorded > known) continue;
    if (assertionSubjects.has(revision.assertion_id) && assertionSubjects.get(revision.assertion_id) !== revision.subject_id) fail('INTEGRITY_FAILED', 'Visible branches of an assertion cannot change its subject');
    assertionSubjects.set(revision.assertion_id, revision.subject_id);
    const encoded = canonicalIdentityJson(revision), existing = byId.get(revision.revision_id);
    if (existing) { if (existing.encoded !== encoded) fail('INTEGRITY_FAILED', 'Visible temporal revision identity has conflicting content'); continue; }
    byId.set(revision.revision_id, {...row, encoded});
    const key = JSON.stringify([revision.assertion_id, revision.branch_id]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const matches = [];
  for (const rows of groups.values()) {
    rows.sort((a, b) => a.revision.recorded_seq - b.revision.recorded_seq);
    for (let i = 0; i < rows.length; i++) {
      const current = rows[i], revision = current.revision, predecessor = byId.get(revision.supersedes_revision_id)?.revision;
      if (revision.supersedes_revision_id === revision.revision_id || predecessor && (predecessor.assertion_id !== revision.assertion_id || predecessor.branch_id !== revision.branch_id || predecessor.subject_id !== revision.subject_id || predecessor.recorded_seq >= revision.recorded_seq)) fail('INTEGRITY_FAILED', 'Temporal predecessor crosses or reverses a visible lineage');
      if (i) {
        const prior = rows[i - 1];
        if (prior.revision.subject_id !== revision.subject_id || prior.revision.recorded_seq === revision.recorded_seq || prior.revision.revision_no >= revision.revision_no || prior.recorded > current.recorded || predecessor && predecessor.revision_id !== prior.revision.revision_id) fail('INTEGRITY_FAILED', 'Temporal assertion branch has conflicting visible revisions');
      }
    }
    const row = rows.at(-1), revision = row.revision;
    // Pick the last known correction first. An ended correction never exposes
    // the superseded version merely because its earlier interval still matches.
    if (row.from !== null && valid < row.from || row.to !== null && valid >= row.to) continue;
    const uncertain = revision.valid_from.kind === 'unknown' || revision.valid_to.kind === 'unknown';
    if (uncertain && !selection.include_uncertain) continue;
    matches.push({revision, match: uncertain ? 'UNKNOWN' : 'MATCH'});
  }
  matches.sort((a, b) => a.revision.revision_id < b.revision.revision_id ? -1 : a.revision.revision_id > b.revision.revision_id ? 1 : 0);
  // Linear conflict scan: separate subjects may legitimately match together.
  const projects = new Map(), branches = new Map(); let conflict = false;
  for (const {revision, match} of matches) {
    if (match !== 'MATCH') continue;
    const project = revision.scope.project_id;
    if (project !== null) {
      if (projects.has(revision.subject_id) && projects.get(revision.subject_id) !== project) conflict = true;
      projects.set(revision.subject_id, project);
    }
    if (branches.has(revision.assertion_id) && branches.get(revision.assertion_id) !== revision.branch_id) conflict = true;
    branches.set(revision.assertion_id, revision.branch_id);
  }
  return {matches, presence: matches.length ? 'OBSERVED' : 'NOT_OBSERVED_IN_CAPTURED_EVIDENCE', conflict, winner: null};
}
