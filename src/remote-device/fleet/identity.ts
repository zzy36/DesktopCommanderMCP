import { createHash, createPublicKey, verify } from 'crypto';
import { FLEET_PROTOCOL_VERSION } from './protocol.js';

export function canonicalHostname(value: string): string {
    const hostname = value.trim();
    if (!hostname) throw new Error('hostname must not be empty');
    return hostname.toUpperCase();
}

export function fingerprintPublicKey(publicKeyPem: string): string {
    const key = createPublicKey(publicKeyPem);
    const der = key.export({ type: 'spki', format: 'der' });
    const digest = createHash('sha256').update(der).digest('hex');
    return `sha256:${digest}`;
}

export function handshakePayload(
    challengeBase64: string,
    hostnameInput: string,
    policyRevision: string,
): Buffer {
    return Buffer.from(JSON.stringify({
        protocolVersion: FLEET_PROTOCOL_VERSION,
        challenge: challengeBase64,
        hostname: canonicalHostname(hostnameInput),
        policyRevision,
    }), 'utf8');
}

export function verifyChallengeSignature(
    publicKeyPem: string,
    payload: Buffer,
    signatureBase64: string,
): boolean {
    try {
        return verify(
            null,
            payload,
            createPublicKey(publicKeyPem),
            Buffer.from(signatureBase64, 'base64'),
        );
    } catch {
        return false;
    }
}
