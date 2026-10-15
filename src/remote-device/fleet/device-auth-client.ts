import { createHash, randomBytes } from 'node:crypto';
import open from 'open';

type StartResponse = {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval?: number;
};

type PollResponse = {
    status: 'approved';
    device_id: string;
    hostname: string;
    public_key_fingerprint: string;
    policy_revision: string;
    credential_type: 'ed25519';
};

function arg(name: string): string | null {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
function has(name: string): boolean { return process.argv.includes(name); }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function requireArg(name: string): string {
    const value = arg(name);
    if (!value) throw new Error(`${name} 为必填参数`);
    return value;
}

async function postJson(url: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    let parsed: any = null;
    try { parsed = await response.json(); } catch { /* handled below */ }
    return { status: response.status, body: parsed };
}

async function main(): Promise<void> {
    if (has('--help') || has('-h')) {
        console.log(`Local Control MCP 设备验证\n\n用法:\n  node device-auth-client.js --admin-url https://HOST:PORT/admin --hostname HOST --fingerprint sha256:... --policy-revision control@... [--no-open] [--json]\n`);
        return;
    }
    const adminUrl = new URL(requireArg('--admin-url'));
    const origin = adminUrl.origin;
    const hostname = requireArg('--hostname');
    const fingerprint = requireArg('--fingerprint');
    const policyRevision = requireArg('--policy-revision');
    const json = has('--json');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');

    const started = await postJson(`${origin}/device/start`, {
        client_id: 'lcm-device',
        scope: 'mcp:tools',
        device_name: hostname,
        fingerprint,
        policy_revision: policyRevision,
        code_challenge: challenge,
        code_challenge_method: 'S256',
    });
    if (started.status !== 200 || !started.body?.device_code) throw new Error(started.body?.error ?? `device/start failed: HTTP ${started.status}`);
    const auth = started.body as StartResponse;

    if (!json) {
        console.log('🔐 正在将这台电脑连接到 Local Control MCP...\n');
        console.log('📋 请完成设备验证：\n');
        console.log('   1. 请在浏览器中确认这台设备：');
        console.log(`      ${auth.verification_uri_complete}\n`);
        console.log('   2. 请确认验证码一致：');
        console.log(`      ${auth.user_code}\n`);
        console.log(`   验证码将在 ${Math.max(1, Math.floor(auth.expires_in / 60))} 分钟后过期。\n`);
    }
    if (!has('--no-open')) {
        try { await open(auth.verification_uri_complete); }
        catch { if (!json) console.log(`   无法自动打开浏览器，请手动访问： ${auth.verification_uri}`); }
    }
    if (!json) console.log('   - ⏳ 正在等待浏览器确认...\n');

    const intervalMs = Math.max(1000, (auth.interval ?? 2) * 1000);
    const deadline = Date.now() + Math.max(10_000, auth.expires_in * 1000);
    while (Date.now() < deadline) {
        await sleep(intervalMs);
        const polled = await postJson(`${origin}/device/poll`, {
            device_code: auth.device_code,
            client_id: 'lcm-device',
            code_verifier: verifier,
        });
        if (polled.status === 200 && polled.body?.status === 'approved') {
            const result = polled.body as PollResponse;
            if (json) console.log(JSON.stringify({ user_code: auth.user_code, ...result }));
            else {
                console.log('✅ 设备验证成功\n');
                console.log(`   设备：       ${result.hostname}`);
                console.log(`   指纹：       ${result.public_key_fingerprint}`);
                console.log('   身份：       Ed25519（私钥仅保留在本机）\n');
            }
            return;
        }
        const error = polled.body?.error;
        if (error === 'authorization_pending' || error === 'slow_down') continue;
        if (error === 'expired_token') throw new Error('设备验证码已过期');
        throw new Error(polled.body?.error_description ?? error ?? `device/poll failed: HTTP ${polled.status}`);
    }
    throw new Error('设备验证超时：未在有效时间内完成浏览器确认');
}

main().catch((error) => {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
