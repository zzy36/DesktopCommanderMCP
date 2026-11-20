import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { Request, Response as ExpressResponse } from 'express';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { FleetPluginBackend, FLEET_SERVER_INFO, FLEET_SERVER_OPTIONS, listFleetTools, callFleetTool } from './plugin-server.js';

const gzipBody = promisify(gzip);

/** Official per-request transport: modern envelopes and stateless legacy clients
 * share the same catalog, dispatcher and validated bearer scopes. */
export function createFleetModernMcpHandler(backend: FleetPluginBackend) {
    const handler = createMcpHandler(() => {
        const server = new Server(FLEET_SERVER_INFO, FLEET_SERVER_OPTIONS);
        server.setRequestHandler('tools/list', async () => ({
            // Discovery already carries the shared brand icon. Do not repeat its
            // inline SVG in every entry sent over the public transport.
            tools: listFleetTools().tools.map(({ icons: _sharedIcon, ...tool }) => tool),
        }));
        server.setRequestHandler('tools/call', async (request, ctx) =>
            callFleetTool(backend, { enforceOAuthScopes: true }, request, { authInfo: ctx.http?.authInfo }));
        return server;
    }, { legacy: 'stateless', maxRequestBodySize: 256 * 1024 });
    const adapterOptions = { maxRequestBodySize: 256 * 1024 };
    const sendMcp = toNodeHandler(handler, adapterOptions);
    const sendCompressedList = toNodeHandler({
        async fetch(request, options) {
            const response = await handler.fetch(request, options);
            const contentType = response.headers.get('content-type')?.split(';', 1)[0];
            if (response.status !== 200 || contentType !== 'application/json' || !response.body) {
                return response;
            }

            // Compress the catalog for clients that accept it. Keep streamed MCP
            // results on the normal response path.
            const body = await gzipBody(new Uint8Array(await response.arrayBuffer()));
            const headers = new Headers(response.headers);
            headers.set('content-encoding', 'gzip');
            headers.set('content-length', String(body.byteLength));
            return new Response(new Uint8Array(body), { status: response.status, headers });
        },
    }, adapterOptions);

    return (req: Request, res: ExpressResponse, body: unknown) => {
        if (req.body?.method === 'tools/list') {
            res.vary('Accept-Encoding');
            if (req.acceptsEncodings('gzip', 'identity') === 'gzip') {
                return sendCompressedList(req, res, body);
            }
        }
        return sendMcp(req, res, body);
    };
}
