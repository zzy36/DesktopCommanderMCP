export interface FleetPairingClientOptions {
    gatewayUrl: string;
    code: string;
    hostname: string;
    fingerprint: string;
    policyRevision: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

export interface FleetPairingClientResult {
    status: string;
    hostname?: string;
    fingerprint?: string | null;
    policyRevision?: string | null;
}

export function fleetPairingOrigin(gatewayUrl: string): string {
    const url = new URL(gatewayUrl);
    if (url.protocol === 'wss:') url.protocol = 'https:';
    else if (url.protocol === 'ws:') url.protocol = 'http:';
    else throw new Error(`unsupported Fleet Gateway protocol for pairing: ${url.protocol}`);
    return url.origin;
}

export async function claimAndWaitForFleetPairing(
    options: FleetPairingClientOptions,
): Promise<FleetPairingClientResult> {
    if (!options.code.trim()) throw new Error('Fleet pairing code is required');
    const fetchImpl = options.fetchImpl ?? fetch;
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const timeoutMs = clamp(options.timeoutMs ?? 10 * 60_000, 10_000, 60 * 60_000);
    const pollIntervalMs = clamp(options.pollIntervalMs ?? 2_000, 250, 30_000);
    const origin = fleetPairingOrigin(options.gatewayUrl);

    const claimResponse = await fetchImpl(`${origin}/pair/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            code: options.code,
            hostname: options.hostname,
            fingerprint: options.fingerprint,
            policyRevision: options.policyRevision,
        }),
    });
    const claim = await readJsonResponse(claimResponse, 'pairing claim');
    if (claim.status === 'approved') return claim;
    if (claim.status !== 'claimed') throw new Error(`Fleet pairing claim returned unexpected status: ${claim.status}`);

    const deadline = now() + timeoutMs;
    while (now() < deadline) {
        await sleep(pollIntervalMs);
        const statusResponse = await fetchImpl(`${origin}/pair/status?code=${encodeURIComponent(options.code)}`, {
            method: 'GET',
            headers: { accept: 'application/json' },
        });
        const status = await readJsonResponse(statusResponse, 'pairing status');
        if (status.status === 'approved') return status;
        if (status.status === 'expired') throw new Error('Fleet pairing code expired before approval');
        if (status.status !== 'claimed') throw new Error(`Fleet pairing returned unexpected status: ${status.status}`);
    }
    throw new Error('Timed out waiting for Fleet pairing approval');
}

async function readJsonResponse(response: Response, label: string): Promise<FleetPairingClientResult> {
    const body = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
        parsed = body ? JSON.parse(body) as Record<string, unknown> : {};
    } catch {
        throw new Error(`${label} returned invalid JSON (HTTP ${response.status})`);
    }
    if (!response.ok) {
        const message = typeof parsed.error === 'string' ? parsed.error : `${label} failed`;
        throw new Error(`${message} (HTTP ${response.status})`);
    }
    return {
        status: String(parsed.status ?? ''),
        hostname: typeof parsed.hostname === 'string' ? parsed.hostname : undefined,
        fingerprint: typeof parsed.fingerprint === 'string' || parsed.fingerprint === null ? parsed.fingerprint as string | null : undefined,
        policyRevision: typeof parsed.policyRevision === 'string' || parsed.policyRevision === null ? parsed.policyRevision as string | null : undefined,
    };
}

function clamp(value: number, minimum: number, maximum: number): number {
    if (!Number.isFinite(value)) return minimum;
    return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}
