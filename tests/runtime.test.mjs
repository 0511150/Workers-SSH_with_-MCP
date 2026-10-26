import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
function convertOptions(options) {
  const converted = convertV4MiniflareOptions(options);
  converted.workers[0].dev.stripCfConnectingIp = false;
  if (options.durableObjectsPersist) converted.resourcePersistencePath = options.durableObjectsPersist;
  return converted;
}
const createMiniflare = options => new Miniflare(convertOptions(options));
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Test-only RPC controls allow clock-independent ban persistence assertions.
const bundle = await build({ stdin: { contents: `
import worker, { AuthGuard, SSHSessionDO } from './src/worker.ts';
export { SSHSessionDO };
export class TestAuthGuard extends AuthGuard {
  async seed(state) { await this.ctx.storage.put('ban', state); }
  async seedCalls(rows) { await this.ctx.storage.put('mcp-calls', rows); }
  async rawServer(id) { return await this.ctx.storage.get('server:' + id); }
  async snapshot() { return await this.ctx.storage.get('ban'); }
}
export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/__test_seed') { await env.AUTH_GUARD.getByName(url.searchParams.get('ip')).seed(await request.json()); return new Response('ok'); }
  if (url.pathname === '/__test_raw_server') return Response.json(await env.AUTH_GUARD.getByName('__servers').rawServer(url.searchParams.get('id')));
  if (url.pathname === '/__test_snapshot') return Response.json(await env.AUTH_GUARD.getByName(url.searchParams.get('ip')).snapshot());
  if (url.pathname === '/__test_seed_calls') { await env.AUTH_GUARD.getByName('__mcp-audit').seedCalls(await request.json()); return new Response('ok'); }
  return worker.fetch(request, env);
} };`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:*'], target: 'es2022' });
const key = 'test-only-long-random-key-please-ignore';
const mf = createMiniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-07-01', bindings: { ACCESS_KEY: key }, durableObjects: { AUTH_GUARD: { className: 'TestAuthGuard', useSQLite: true }, SSH_SESSIONS: { className: 'SSHSessionDO', useSQLite: true } }, serviceBindings: { ASSETS: () => new Response('<html>authenticated application</html>', { headers: { 'Content-Type': 'text/html' } }) } });
after(() => mf.dispose());
let sequence = 1;
function request(path, options = {}, ip = '203.0.113.1') {
  return mf.dispatchFetch(`https://example.com${path}`, { ...options, headers: { 'CF-Connecting-IP': ip, ...options.headers } });
}
function mcp(message, headers = {}, ip) {
  return request('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(message) }, ip);
}
function rpc(method, params = {}) { return { jsonrpc: '2.0', id: sequence++, method, params }; }
test('page is gated, login issues secure cookie, cookie unlocks application; logout clears it', async () => {
  const page = await request('/');
  assert.match(await page.text(), /PRIVATE ACCESS/);
  assert.match(page.headers.get('Content-Security-Policy'), /script-src 'self'/);
  assert.match(await (await request('/missing.js')).text(), /PRIVATE ACCESS/);
  const response = await request('/auth/login', { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('Set-Cookie');
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(cookie.includes(flag));
  const auth = await request('/', { headers: { Cookie: cookie.split(';')[0] } });
  assert.match(await auth.text(), /authenticated application/);
  const tampered = await request('/', { headers: { Cookie: cookie.split(';')[0] + 'x' } });
  assert.match(await tampered.text(), /PRIVATE ACCESS/);
  const logout = await request('/auth/logout', { method: 'POST', headers: { Origin: 'https://example.com' } });
  assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0/);
  const cookieMcp = await mcp(rpc('tools/list'), { Authorization: '', Cookie: cookie.split(';')[0] }, '203.0.113.55');
  assert.equal(cookieMcp.status, 401);
});
test('unauthenticated SSH session and every auxiliary endpoint are denied', async () => {
  for (const path of ['/api/session', '/api/ssh', '/api/sftp', '/api/processes', '/api/network', '/api/geo']) {
    const response = await request(path, {}, `203.0.113.${sequence++}`);
    assert.equal(response.status, 401);
  }
});
test('MCP initialize, tools/list, ping, notifications and HTTP negotiation', async () => {
  const initialize = await mcp(rpc('initialize', { protocolVersion: '2025-06-18' }));
  assert.equal((await initialize.json()).result.protocolVersion, '2025-06-18');
  const listed = await (await mcp(rpc('tools/list'))).json();
  assert.deepEqual(listed.result.tools.map(t => t.name), ['vps_list', 'vps_getdata', 'vps_inspect']);
  assert.deepEqual((await (await mcp(rpc('ping'))).json()).result, {});
  assert.equal((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.equal((await mcp(rpc('ping'), { 'MCP-Protocol-Version': 'invalid' })).status, 400);
  assert.equal((await mcp(rpc('ping'), { Accept: 'text/plain' })).status, 406);
  assert.equal((await request('/mcp', { headers: { Authorization: `Bearer ${key}` } })).status, 405);
  assert.equal((await mcp(rpc('ping'), { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await mcp([])).status, 400);
});
test('three stateless tools reject invalid IDs, extra fields and retired session tools', async () => {
  for (const [name, args] of [['vps_inspect', {}], ['vps_list', { connectionId: 'a'.repeat(64) }], ['vps_getdata', { id: '../bad' }], ['ssh_connect', {}], ['ssh_read', {}]]) {
    const result = await (await mcp(rpc('tools/call', { name, arguments: args }))).json();
    assert.equal(result.error.code, -32602);
  }
  const missing = await (await mcp(rpc('tools/call', { name: 'vps_getdata', arguments: { id: 'missing' } }))).json();
  assert.equal(missing.result.isError, true);
});

test('server vault is authenticated, shared by MCP, and only getdata returns credentials', async () => {
  const server = { id: 'vault-test', name: 'Test', host: 'example.com', port: 22, username: 'root', authMethod: 'password', password: 'sensitive-must-not-be-stored-in-audit' };
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  assert.equal((await request('/api/servers', { method: 'PUT', body: JSON.stringify(server) }, '203.0.113.233')).status, 401);
  assert.equal((await request('/api/servers', { method: 'PUT', headers, body: JSON.stringify(server) })).status, 200);
  const listed = await (await mcp(rpc('tools/call', { name: 'vps_list' }))).json();
  assert.equal(listed.result.content[0].text.includes(server.password), false);
  assert.equal(JSON.parse(listed.result.content[0].text).servers.some(s => s.id === server.id), true);
  const detail = await (await mcp(rpc('tools/call', { name: 'vps_getdata', arguments: { id: server.id } }))).json();
  assert.equal(JSON.parse(detail.result.content[0].text).password, server.password);
  const inspected = await (await mcp(rpc('tools/call', { name: 'vps_inspect', arguments: { id: server.id } }))).json();
  assert.match(inspected.result.content[0].text, /fingerprint/);
  const stored = await (await request('/__test_raw_server?id=vault-test')).text();
  assert.equal(stored.includes(server.password), false);
  assert.equal(stored.includes('example.com'), false);
  const audit = await (await request('/api/audit', { headers })).text();
  assert.equal(audit.includes(server.password), false);
  await request('/api/servers?id=vault-test', { method: 'DELETE', headers });
  assert.equal((await request('/api/servers?id=vault-test', { headers })).status, 400);
});

test('web and MCP share the same fail2ban counter and key', async () => {
  const ip = '203.0.113.234';
  for (let n = 0; n < 4; n++) {
    const response = n % 2 ? await mcp(rpc('ping'), { Authorization: 'Bearer wrong' }, ip) : await request('/auth/login', { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'wrong' }) }, ip);
    assert.equal(response.status, 401);
  }
  assert.equal((await mcp(rpc('ping'), { Authorization: 'Bearer wrong' }, ip)).status, 429);
  const login = await request('/auth/login', { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }, ip);
  assert.equal(login.status, 429);
});

test('concurrent bad keys persist strikes and a permanent ban blocks even the correct key; admin can recover', async () => {
  const ip = '203.0.113.220';
  const statuses = await Promise.all(Array.from({ length: 5 }, () => mcp(rpc('ping'), { Authorization: 'Bearer wrong' }, ip).then(r => r.status)));
  assert.equal(statuses.filter(s => s === 401).length, 4);
  assert.equal(statuses.filter(s => s === 429).length, 1);
  assert.equal((await mcp(rpc('ping'), {}, ip)).status, 429);
  for (let strikes = 1; strikes <= 3; strikes++) {
    const stored = await (await request(`/__test_snapshot?ip=${ip}`)).json();
    assert.equal(stored.strikes, strikes);
    await request(`/__test_seed?ip=${ip}`, { method: 'POST', body: JSON.stringify({ ...stored, until: Date.now() - 1 }) });
    for (let i = 0; i < 5; i++) await mcp(rpc('ping'), { Authorization: 'Bearer wrong' }, ip);
  }
  const permanent = await mcp(rpc('ping'), {}, ip);
  assert.equal(permanent.status, 429);
  assert.equal((await permanent.json()).until, -1);
  // Another IP is independent and can administer the banned address.
  const recovered = await request('/api/admin/unban', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify({ ip }) }, '203.0.113.221');
  assert.equal(recovered.status, 200);
  assert.equal((await mcp(rpc('ping'), {}, ip)).status, 200);
});
test('login origin, bounded body, and HTTPS enforcement reject hostile requests', async () => {
  assert.equal((await request('/auth/login', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await request('/auth/login', { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: 'x'.repeat(17000) })).status, 400);
  const insecure = await mf.dispatchFetch('http://example.com/mcp', { method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.222' } });
  assert.equal(insecure.status, 403);
});
test('official MCP SDK can initialize, list tools, ping and receive tool errors', async () => {
  const transport = new StreamableHTTPClientTransport(new URL('https://example.com/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
    fetch: (url, init) => request(new URL(String(url)).pathname, { ...init, headers: Object.fromEntries(new Headers(init?.headers)) }, '203.0.113.230'),
  });
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  client.onerror = () => {}; // GET SSE is deliberately unsupported (405).
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 3);
    await client.ping();
    const result = await client.callTool({ name: 'vps_getdata', arguments: { id: 'missing' } });
    assert.equal(result.isError, true);
  } finally { await client.close(); }
});
test('MCP audit requires authentication, retains 500 entries and excludes credentials and input', async () => {
  const seeded = Array.from({ length: 500 }, (_, i) => ({ id: `seed-${i}`, timestamp: i, tool: 'ssh_read', host: '', success: true, duration: 0 }));
  await request('/__test_seed_calls', { method: 'POST', body: JSON.stringify(seeded) });
  const result = await mcp(rpc('tools/call', { name: 'vps_getdata', arguments: { id: 'missing' } }));
  assert.equal((await result.json()).result.isError, true);
  assert.equal((await request('/api/audit', {}, '203.0.113.232')).status, 401);
  const response = await request('/api/audit', { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const text = await response.text();
  assert.equal(text.includes('sensitive-must-not-be-stored'), false);
  assert.equal(text.includes(key), false);
  const rows = JSON.parse(text).calls;
  assert.equal(rows.length, 500);
  assert.equal(rows[0].tool, 'web_auth');
  assert.equal(rows[0].success, false);
  assert.equal(rows.at(-1).id, 'seed-2');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['duration','host','id','success','timestamp','tool']);
  const longRows = Array.from({ length: 300 }, (_, i) => ({ id: `long-${i}`, timestamp: i, tool: 'ssh_connect', host: 'h'.repeat(253), success: true, duration: 0 }));
  await request('/__test_seed_calls', { method: 'POST', body: JSON.stringify(longRows) });
  await mcp(rpc('tools/call', { name: 'vps_getdata', arguments: { id: 'missing' } }));
  const bounded = await (await request('/api/audit', { headers: { Authorization: `Bearer ${key}` } })).json();
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.calls)) <= 96 * 1024);
  assert.ok(bounded.calls.length < 301);
});
test('SQLite ban survives disposal and a fresh runtime, and missing or short keys fail closed', async () => {
  const path = await mkdtemp(join(tmpdir(), 'webssh-ban-test-'));
  const options = { modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-07-01', durableObjectsPersist: path, durableObjects: { AUTH_GUARD: { className: 'TestAuthGuard', useSQLite: true }, SSH_SESSIONS: { className: 'SSHSessionDO', useSQLite: true } }, bindings: { ACCESS_KEY: key } };
  const first = createMiniflare(options);
  await first.dispatchFetch('https://example.com/__test_seed?ip=203.0.113.240', { method: 'POST', body: JSON.stringify({ failures: 0, strikes: 4, until: -1 }) });
  await first.dispatchFetch('https://example.com/__test_seed_calls', { method: 'POST', body: JSON.stringify([{ id: 'persistent-audit', timestamp: 1, tool: 'ssh_read', host: '', success: true, duration: 2 }]) });
  await first.dispatchFetch('https://example.com/api/servers', { method: 'PUT', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'persistent', host: 'example.com', port: 22, username: 'test', authMethod: 'password', password: 'persistent-secret' }) });
  await first.dispose();
  const restarted = createMiniflare(options);
  try {
    const snapshot = await (await restarted.dispatchFetch('https://example.com/__test_snapshot?ip=203.0.113.240')).json();
    assert.equal(snapshot.until, -1, JSON.stringify(snapshot));
    const response = await restarted.dispatchFetch('https://example.com/mcp', { method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.240', Authorization: `Bearer ${key}` } });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).until, -1);
    const audit = await restarted.dispatchFetch('https://example.com/api/audit', { headers: { Authorization: `Bearer ${key}` } });
    assert.ok((await audit.json()).calls.some(row => row.id === 'persistent-audit'));
    const saved = await restarted.dispatchFetch('https://example.com/api/servers?id=persistent', { headers: { Authorization: `Bearer ${key}` } });
    assert.equal((await saved.json()).server.password, 'persistent-secret');
    await restarted.setOptions(convertOptions({ ...options, bindings: { ACCESS_KEY: 'short' } }));
    assert.equal((await restarted.dispatchFetch('https://example.com/api/session')).status, 503);
    await restarted.setOptions(convertOptions({ ...options, bindings: {} }));
    assert.equal((await restarted.dispatchFetch('https://example.com/api/session')).status, 503);
  } finally { await restarted.dispose(); }
});
