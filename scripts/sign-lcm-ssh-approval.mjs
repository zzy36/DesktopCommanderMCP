#!/usr/bin/env node
/**
 * Offline signing utility. Never store the private key under LCM-accessible
 * directories, in Git, or on the managed executor's filesystem.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, sign } from 'node:crypto';

function fail(message) { console.error(message); process.exitCode = 2; }
function argsOf(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || !argv[i+1]) throw new Error('Use --key, --host, --alias, --approved-by, --command-file, --out, [--ttl-seconds]');
    out[argv[i].slice(2)] = argv[i+1];
  }
  return out;
}
try {
  const a = argsOf(process.argv.slice(2));
  const required = ['key','host','alias','approved-by','command-file','out'];
  if (required.some(k => !a[k])) throw new Error('Missing required signing parameter');
  const command = (await readFile(a['command-file'], 'utf8')).replace(/\r?\n$/, '');
  const m = /^ssh -o BatchMode=yes ([A-Za-z0-9][A-Za-z0-9._-]{0,63}) '([A-Za-z0-9_./= -]+)'$/.exec(command);
  if (!m || m[1] !== a.alias) throw new Error('Command must be one literal SSH invocation of the supplied alias');
  if (!/^[A-Za-z0-9._@-]{1,80}$/.test(a['approved-by'])) throw new Error('Invalid approver label');
  if (!/^[A-Za-z0-9._-]+$/.test(a.host)) throw new Error('Invalid hostname');
  const ttl = a['ttl-seconds'] === undefined ? 300 : Number(a['ttl-seconds']);
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 900) throw new Error('ttl-seconds must be 1..900');
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({
    v:1,host:a.host.toUpperCase(),alias:a.alias,
    command_sha256:createHash('sha256').update(command).digest('hex'),
    issued_at:now,expires_at:now+ttl*1000,
    nonce:randomBytes(16).toString('hex'),approved_by:a['approved-by'],
  }), 'utf8');
  const secretKey = await readFile(a.key);
  const token = payload.toString('base64url') + '.' + sign(null,payload,secretKey).toString('base64url');
  await writeFile(a.out,token+'\n',{encoding:'utf8',flag:'wx',mode:0o600});
  console.log('Signed SSH approval written to '+a.out+'. Keep it private; one attempt, expires in '+ttl+' seconds.');
} catch (e) { fail(e instanceof Error ? e.message : String(e)); }
