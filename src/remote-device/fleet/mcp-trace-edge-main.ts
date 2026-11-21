import { createMcpTraceEdge } from './mcp-trace-edge.js';
import { readTraceKey } from './mcp-request-trace.js';

const [listenArg, upstreamArg] = process.argv.slice(2);
const listenPort = Number(listenArg);
const upstreamPort = Number(upstreamArg);
const unixSocket = listenArg?.startsWith('/') && listenArg.endsWith('.sock') ? listenArg : undefined;
const validPort = (port: number) => Number.isInteger(port) && port > 1023 && port <= 65_535;
if (!validPort(upstreamPort) || (!unixSocket && (!validPort(listenPort) || listenPort === upstreamPort))) {
    throw new Error('Provide a Unix socket or loopback listen port and a distinct FRP upstream port');
}
const key = readTraceKey(process.env.LCM_MCP_TRACE_KEY);
if (!key) throw new Error('MCP trace key is required');

const server = createMcpTraceEdge(upstreamPort, key);
if (unixSocket) server.listen(unixSocket);
else server.listen(listenPort, '127.0.0.1');
process.once('SIGTERM', () => server.close());
