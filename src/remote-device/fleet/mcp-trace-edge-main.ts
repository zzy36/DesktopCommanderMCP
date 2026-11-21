import { createMcpTraceEdge } from './mcp-trace-edge.js';
import { readTraceKey } from './mcp-request-trace.js';

const [listenArg, upstreamArg] = process.argv.slice(2);
const listenPort = Number(listenArg);
const upstreamPort = Number(upstreamArg);
if (![listenPort, upstreamPort].every(port => Number.isInteger(port) && port > 1023 && port <= 65_535)
    || listenPort === upstreamPort) {
    throw new Error('Provide distinct non-privileged loopback listen and FRP upstream ports');
}
const key = readTraceKey(process.env.LCM_MCP_TRACE_KEY);
if (!key) throw new Error('MCP trace key is required');

const server = createMcpTraceEdge(upstreamPort, key);
server.listen(listenPort, '127.0.0.1');
process.once('SIGTERM', () => server.close());
