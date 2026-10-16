import { startInteractiveUserBridge } from './interactive-user-bridge.js';
import { loadAgentServiceConfig } from './service-config.js';
const args = process.argv.slice(2);
const value = (name: string) => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw new Error(`${name} required`); return args[index + 1]; };
const configIndex = args.indexOf('--config');
const config = configIndex >= 0 ? await loadAgentServiceConfig(value('--config')) : undefined;
const bridge = await startInteractiveUserBridge({ controlRoot: config?.controlRoot ?? (args.includes('--control-root') ? value('--control-root') : ''), stateDir: config?.interactiveStateDir ?? value('--state-dir'), deviceFirst: config?.deviceFirst ?? true, executionPolicy: config?.executionPolicy });
console.log(JSON.stringify({ service: 'lcm-interactive-user', ready: true, hostname: bridge.hostname, username: bridge.username, sessionId: bridge.sessionId }));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void bridge.close().then(() => process.exit(0)); });
