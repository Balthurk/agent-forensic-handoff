// Service format v2. Private key/header metadata arrives only on stdin.
// Authentication mode discards every plaintext byte until GCM final succeeds.
import {createCipheriv, createDecipheriv} from 'node:crypto';
const demand = ok => { if (!ok) throw new Error('invalid service member'); };
const write = bytes => new Promise((resolve, reject) => process.stdout.write(bytes, error => error ? reject(error) : resolve()));
let key;
try {
  let pending = Buffer.alloc(0), length = null, metadata = null, cipher = null, seen = 0;
  let lines = Buffer.alloc(0), omit = null, omitted = 0;
  const output = async bytes => { if (metadata.mode !== 'authenticate' && bytes.length) await write(bytes); };
  const plaintext = async bytes => {
    if (!omit) { await output(bytes); return; }
    lines = Buffer.concat([lines, bytes]);
    let end;
    while ((end = lines.indexOf(10)) !== -1) {
      demand(end <= 65536);
      const line = lines.subarray(0, end + 1); lines = lines.subarray(end + 1);
      if (line.equals(omit)) { omitted++; demand(omitted === 1); } else await output(line);
    }
    demand(lines.length <= 65536);
  };
  for await (const incoming of process.stdin) {
    let body = incoming;
    if (!metadata) {
      pending = Buffer.concat([pending, body]); body = Buffer.alloc(0);
      if (length === null && pending.length >= 4) { length = pending.readUInt32BE(); demand(length > 0 && length <= 8192); pending = pending.subarray(4); }
      if (length === null || pending.length < length) continue;
      metadata = JSON.parse(pending.subarray(0, length).toString('utf8')); body = pending.subarray(length); pending = Buffer.alloc(0);
      demand(JSON.stringify(Object.keys(metadata)) === JSON.stringify(['mode', 'key', 'header', 'nonce', 'tag', 'bytes', 'limit', 'bootstrapRole']));
      demand(['encrypt', 'decrypt', 'authenticate'].includes(metadata.mode));
      key = Buffer.from(metadata.key, 'base64'); metadata.key = '';
      const header = Buffer.from(metadata.header, 'base64'), nonce = Buffer.from(metadata.nonce, 'base64');
      demand(key.length === 32 && nonce.length === 12 && header.length > 24 && header.length <= 4096);
      demand(Number.isSafeInteger(metadata.limit) && metadata.limit >= 0 && metadata.limit <= 50 * 1024 ** 3);
      demand(metadata.bytes === null || Number.isSafeInteger(metadata.bytes) && metadata.bytes >= 0 && metadata.bytes <= metadata.limit);
      if (metadata.bootstrapRole !== null) {
        demand(metadata.mode !== 'encrypt' && typeof metadata.bootstrapRole === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(metadata.bootstrapRole));
        omit = Buffer.from(`CREATE ROLE "${metadata.bootstrapRole}";\n`);
      }
      cipher = metadata.mode === 'encrypt' ? createCipheriv('aes-256-gcm', key, nonce) : createDecipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(header);
      if (metadata.mode !== 'encrypt') { const tag = Buffer.from(metadata.tag, 'base64'); demand(tag.length === 16 && metadata.bytes !== null); cipher.setAuthTag(tag); }
    }
    seen += body.length; demand(seen <= metadata.limit && (metadata.bytes === null || seen <= metadata.bytes));
    if (body.length) await plaintext(cipher.update(body));
  }
  demand(metadata && (metadata.bytes === null || seen === metadata.bytes));
  const last = cipher.final(); await plaintext(last);
  if (omit) { await output(lines); demand(omitted === 1); }
  if (metadata.mode === 'encrypt') await write(cipher.getAuthTag());
} catch {
  process.stderr.write('SERVICE_MEMBER_AUTHENTICATION_OR_TRANSPORT_FAILED\n'); process.stdin.destroy(); process.exitCode = 1;
} finally { key?.fill(0); process.stdout.end(); }
