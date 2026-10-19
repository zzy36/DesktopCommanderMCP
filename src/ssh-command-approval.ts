/**
 * Narrow, fail-closed exception for an externally signed SSH command.
 * This never alters blockedCommands or the external L1 execution policy.
 */
import { createHash, verify as verifySignature } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SshApprovalResult = { allowed: boolean; reason: string; nonce?: string };
type Claim = {
  v: number;
  host: string;
  alias: string;
  command_sha256: string;
  issued_at: number;
  expires_at: number;
  nonce: string;
  approved_by: string;
};

export const commandDigest = (command: string): string =>
  createHash('sha256').update(command, 'utf8').digest('hex');

export function sshAlias(command: string): string | null {
  // Conservative PowerShell syntax: one literal SSH invocation, one quoted remote
  // command, no local/remote interpolation, separators or command substitutions.
  const match = /^ssh -o BatchMode=yes ([A-Za-z0-9][A-Za-z0-9._-]{0,63}) '([A-Za-z0-9_./= -]+)'$/.exec(command);
  return match?.[1] ?? null;
}

const safeNonce = (s: string): boolean => /^[a-f0-9]{32}$/.test(s);
const safeHash = (s: string): boolean => /^[a-f0-9]{64}$/.test(s);
const b64url = (s: string): boolean => /^[A-Za-z0-9_-]+$/.test(s);

export async function authorizeBlockedSshCommand(
  command: string,
  signedApproval: string | undefined,
  options: {
    hostname?: string;
    publicKeyPath?: string;
    stateDir?: string;
    nowMs?: number;
  } = {},
): Promise<SshApprovalResult> {
  if (!signedApproval) return { allowed: false, reason: 'missing_approval' };
  const alias = sshAlias(command);
  if (!alias) return { allowed: false, reason: 'not_literal_ssh' };
  const hostname = (options.hostname ?? os.hostname()).toUpperCase();
  const pubPath = options.publicKeyPath ?? process.env.LCM_SSH_APPROVAL_PUBLIC_KEY_FILE;
  const stateDir = options.stateDir ?? process.env.LCM_SSH_APPROVAL_STATE_DIR;
  if (!pubPath || !stateDir || !path.isAbsolute(pubPath) || !path.isAbsolute(stateDir))
    return { allowed: false, reason: 'approval_not_configured' };
  const sha = commandDigest(command);
  let claim: Claim | undefined;
  let reason = 'invalid_approval';
  try {
    if (signedApproval.length > 4096) throw new Error('oversize');
    const parts = signedApproval.split('.');
    if (parts.length !== 2 || !parts.every(b64url)) throw new Error('format');
    const bytes = Buffer.from(parts[0], 'base64url');
    if (bytes.length > 2048) throw new Error('oversize');
    claim = JSON.parse(bytes.toString('utf8')) as Claim;
    if (!claim || claim.v !== 1 || typeof claim.host !== 'string' ||
        typeof claim.alias !== 'string' || typeof claim.command_sha256 !== 'string' ||
        !safeHash(claim.command_sha256) || typeof claim.nonce !== 'string' ||
        !safeNonce(claim.nonce) || typeof claim.approved_by !== 'string' ||
        !/^[A-Za-z0-9._@-]{1,80}$/.test(claim.approved_by) ||
        !Number.isSafeInteger(claim.issued_at) || !Number.isSafeInteger(claim.expires_at)) {
      throw new Error('claims');
    }
    const pub = await fs.readFile(pubPath, 'utf8');
    if (!verifySignature(null, bytes, pub, Buffer.from(parts[1], 'base64url'))) {
      reason = 'invalid_signature'; throw new Error('signature');
    }
    const now = options.nowMs ?? Date.now();
    if (claim.host !== hostname || claim.alias !== alias || claim.command_sha256 !== sha) {
      reason = 'scope_mismatch'; throw new Error('scope');
    }
    if (claim.issued_at > now + 30_000 || claim.expires_at <= now ||
        claim.expires_at - claim.issued_at > 15 * 60_000 ||
        claim.expires_at <= claim.issued_at) {
      reason = 'expired_or_invalid_window'; throw new Error('time');
    }
    // Reserve the nonce *before* executing. Exclusive create rejects racing calls;
    // failed runs still consume the credential (at-most-once attempt).
    const marker = path.join(stateDir, 'used', claim.nonce);
    const handle = await fs.open(marker, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ host: hostname, digest: sha, at: now }) + '\n');
    } finally {
      await handle.close();
    }
    // Audit append is mandatory: if it fails, the nonce stays consumed.
    await fs.appendFile(path.join(stateDir, 'audit.jsonl'),
      JSON.stringify({ event: 'ssh_approval_consumed', at: now, host: hostname,
        alias, sha256: sha, nonce: claim.nonce, approved_by: claim.approved_by }) + '\n',
      'utf8');
    return { allowed: true, reason: 'signed_one_time_approval', nonce: claim.nonce };
  } catch {
    // Never echo tokens, raw commands, SSH secrets or private key paths to logs.
    if (stateDir && path.isAbsolute(stateDir)) {
      try {
        await fs.appendFile(path.join(stateDir, 'audit.jsonl'),
          JSON.stringify({ event: 'ssh_approval_denied', at: options.nowMs ?? Date.now(),
            host: hostname, alias, sha256: sha, reason }) + '\n', 'utf8');
      } catch { /* deny even if audit path is unavailable */ }
    }
    return { allowed: false, reason };
  }
}
