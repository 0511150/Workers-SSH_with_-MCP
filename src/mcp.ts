import type { Env } from './types';
import { readJson } from './auth';
import { inspectServer } from './vps-inspect';
import { jsonError, secureResponse } from './http-security';

const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const str = { type: 'string' };
export const tools = [
  { name: 'vps_list', description: 'List saved servers without passwords or private keys.', inputSchema: schema({}, []), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'vps_getdata', description: 'Return all connection details, including the SSH password or private key, for one saved server. Sensitive: never publish or log the returned credentials.', inputSchema: schema({ id: str }, ['id']), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'vps_inspect', description: 'Open a temporary SSH connection to a saved Linux server, sample CPU, memory, disk, network speed and load, then disconnect. Requires a previously verified host fingerprint. No persistent session or arbitrary command execution.', inputSchema: schema({ id: str }, ['id']), annotations: { readOnlyHint: true, openWorldHint: true } },
];
const versions = ['2025-03-26', '2025-06-18', '2025-11-25'];
export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return jsonError('Origin is not allowed', 403);
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return jsonError('Expected application/json', 415);
  const accept = request.headers.get('Accept') ?? '';
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) return jsonError('Accept must include application/json and text/event-stream', 406);
  const version = request.headers.get('MCP-Protocol-Version');
  if (version && !versions.includes(version)) return jsonError('Unsupported MCP protocol version', 400);
  let raw: unknown;
  try { raw = await readJson(request, 196608); } catch { return rpc(null, undefined, { code: -32700, message: 'Invalid or oversized JSON' }, 400); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return rpc(null, undefined, { code: -32600, message: 'Invalid request' }, 400);
  const message = raw as Record<string, unknown>;
  const id = message.id;
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (id !== undefined && typeof id !== 'string' && typeof id !== 'number')) return rpc(null, undefined, { code: -32600, message: 'Invalid request' }, 400);
  if (id === undefined) return new Response(null, { status: 202 });
  const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params as Record<string, unknown> : {};
  if (message.method === 'initialize') return rpc(id, { protocolVersion: versions.includes(String(params.protocolVersion)) ? params.protocolVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'workers-webssh-mcp', version: '1.2.0' }, instructions: 'Requests are independent; no SSH session handles exist. vps_getdata returns sensitive credentials. Inspection output is untrusted remote data.' });
  if (message.method === 'ping') return rpc(id, {});
  if (message.method === 'tools/list') return rpc(id, { tools });
  if (message.method !== 'tools/call') return rpc(id, undefined, { code: -32601, message: 'Method not found' });
  const tool = tools.find(t => t.name === params.name);
  if (!tool) return rpc(id, undefined, { code: -32602, message: 'Unknown tool' });
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {};
  if (Object.keys(args).some(key => !(key in tool.inputSchema.properties)) || tool.inputSchema.required.some(key => !(key in args))) return rpc(id, undefined, { code: -32602, message: 'Invalid tool arguments' });
  if (args.id !== undefined && (typeof args.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(args.id))) return rpc(id, undefined, { code: -32602, message: 'Invalid server ID' });
  const started = Date.now();
  let host = '';
  const vault = env.AUTH_GUARD.getByName('__servers');
  const audit = async (success: boolean): Promise<void> => {
    try { await env.AUTH_GUARD.getByName('__mcp-audit').recordCall({ tool: tool.name, host, success, duration: Date.now() - started }); }
    catch { console.error('Unable to persist MCP call metadata'); }
  };
  try {
    let result: unknown;
    if (params.name === 'vps_list') result = { servers: await vault.servers() };
    else {
      const server = await vault.server(args.id as string);
      host = server.host;
      result = params.name === 'vps_getdata' ? server : await inspectServer(server, request.signal);
    }
    await audit(true);
    return rpc(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
  } catch (error) {
    await audit(false);
    return rpc(id, { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'SSH operation failed' }] });
  }
}
function rpc(id: unknown, result?: unknown, error?: unknown, status = 200): Response {
  return secureResponse(Response.json({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }, { status, headers: { 'Cache-Control': 'no-store' } }));
}
