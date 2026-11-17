import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { FleetPluginBackend, FLEET_SERVER_INFO, FLEET_SERVER_OPTIONS, listFleetTools, callFleetTool } from './plugin-server.js';

/** Official per-request transport: modern envelopes and stateless legacy clients
 * share the same catalog, dispatcher and validated bearer scopes. */
export function createFleetModernMcpHandler(backend: FleetPluginBackend) {
    const handler = createMcpHandler(() => {
        const server = new Server(FLEET_SERVER_INFO, FLEET_SERVER_OPTIONS);
        server.setRequestHandler('tools/list', async () => listFleetTools());
        server.setRequestHandler('tools/call', async (request, ctx) =>
            callFleetTool(backend, { enforceOAuthScopes: true }, request, { authInfo: ctx.http?.authInfo }));
        return server;
    }, { legacy: 'stateless', maxRequestBodySize: 256 * 1024 });
    return toNodeHandler(handler, { maxRequestBodySize: 256 * 1024 });
}
