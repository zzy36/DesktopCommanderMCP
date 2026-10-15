import { startInteractiveUserBridge } from './interactive-user-bridge.js';
const args = process.argv.slice(2);
const value = (name: string) => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw new Error(`${name} required`); return args[index + 1]; };
const bridge = await startInteractiveUserBridge({ controlRoot: value('--control-root'), stateDir: value('--state-dir') });
console.log(JSON.stringify({ service: 'lcm-interactive-user', ready: true, hostname: bridge.hostname, username: bridge.username, sessionId: bridge.sessionId }));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void bridge.close().then(() => process.exit(0)); });
