import { createHash } from 'node:crypto';

function invalid(message) {
  throw Object.assign(new Error(message), { code: 'INVALID_REQUEST' });
}

/** afh-cjson-v1: sort object keys, preserve array order and exact JSON values. */
export function canonicalIdentityJson(value) {
  const seen = new Set();
  function encode(item) {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) invalid('Identity number must be finite and exact; encode large integers as decimal strings');
      return JSON.stringify(item);
    }
    if (!item || typeof item !== 'object' || seen.has(item)) invalid('Identity must be acyclic JSON');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) invalid('Identity object must be plain JSON');
    seen.add(item);
    let result;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) invalid('Identity arrays must be dense JSON arrays');
      result = '[' + item.map(encode).join(',') + ']';
    } else result = '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + encode(item[key])).join(',') + '}';
    seen.delete(item);
    return result;
  }
  return encode(value);
}

export function identityDigest(value) {
  return createHash('sha256').update(canonicalIdentityJson(value), 'utf8').digest('hex');
}

function nonempty(value, label) {
  if (typeof value !== 'string' || value.length === 0) invalid(label + ' must be a nonempty string');
  return value;
}

export function nativeSessionId({ harness, origin_domain_id, native_id }) {
  return 'ses4-' + identityDigest([
    nonempty(harness, 'harness'), nonempty(origin_domain_id, 'origin_domain_id'), nonempty(native_id, 'native_id')
  ]);
}

/** Resolve against caller-supplied visible identities; no IO, inference or mutation. */
export function resolveNativeAlias(sessions, alias, { origin_domain_id = null } = {}) {
  nonempty(alias, 'alias');
  if (!Array.isArray(sessions)) invalid('sessions must be an array');
  const candidatesById = new Map();
  for (const session of sessions) {
    const id = nativeSessionId(session);
    if (origin_domain_id !== null && session.origin_domain_id !== origin_domain_id) continue;
    if (alias !== id && alias !== `ses:${session.harness}:${session.native_id}`) continue;
    const previous = candidatesById.get(id);
    if (previous) {
      const refs = new Map([...previous.evidence_refs, ...(session.evidence_refs ?? [])].map(ref => [canonicalIdentityJson(ref), structuredClone(ref)]));
      previous.evidence_refs = [...refs.values()];
    } else candidatesById.set(id, { ...structuredClone(session), id, evidence_refs: structuredClone(session.evidence_refs ?? []) });
  }
  const candidates = [...candidatesById.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    error: candidates.length > 1 ? 'AMBIGUOUS_IDENTITY' : null,
    candidates, selected: candidates.length === 1 ? candidates[0] : null
  };
}
