import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const createMiniflare = options => new Miniflare(convertV4MiniflareOptions(options));
const { Server, utils } = ssh2;

// A real local SSH server exercises production crypto/channel handling. Only
// the TEST bundle redirects outbound TCP to this fixture; SSRF validation stays
// active and the production bundle contains no redirection code.
const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
const fingerprint = `SHA256:${createHash('sha256').update(utils.parseKey(hostKey).getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
const identity = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const rsaPem = identity.export({ type: 'pkcs1', format: 'pem' });
const rsaPkcs8 = identity.export({ type: 'pkcs8', format: 'pem' });
const allowedKey = utils.parseKey(rsaPem);
let authAttempts = 0;
const peers = new Set();
const server = new Server({ hostKeys: [hostKey], algorithms: { kex: ['ecdh-sha2-nistp256'], cipher: ['aes128-ctr'], hmac: ['hmac-sha2-256'], serverHostKey: ['rsa-sha2-256'] } }, client => {
  peers.add(client);
  client.on('error', () => {});
  client.on('close', () => peers.delete(client));
  client.on('authentication', ctx => {
    authAttempts++;
    if (ctx.method === 'password' && ctx.username === 'test' && ctx.password === 'fixture-only') ctx.accept();
    else if (ctx.method === 'publickey' && ctx.username === 'test' && ctx.key.data.equals(allowedKey.getPublicSSH()) && (!ctx.signature || allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo))) ctx.accept();
    else ctx.reject();
  });
  client.on('ready', () => client.on('session', accept => {
    const session = accept();
    session.on('pty', acceptPty => acceptPty());
    session.on('shell', acceptShell => {
      const stream = acceptShell();
      stream.write('fixture ready\r\n');
      stream.on('data', chunk => { stream.write(`received: ${chunk.toString()}`); });
    });
  }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const bundle = await build({ entryPoints: ['src/worker.ts'], bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', plugins: [{
  name: 'local-ssh-fixture', setup(builder) {
    builder.onResolve({ filter: /^cloudflare:sockets$/ }, args => args.namespace === 'test-sockets' ? { path: args.path, external: true } : { path: args.path, namespace: 'test-sockets' });
    builder.onLoad({ filter: /.*/, namespace: 'test-sockets' }, () => ({ contents: `import { connect as realConnect } from 'cloudflare:sockets'; export function connect(address, options) { return realConnect({ hostname: '127.0.0.1', port: ${port} }, options); }`, loader: 'js' }));
  },
}], external: ['cloudflare:workers'] });
const key = 'test-only-mcp-fixture-key';
const mf = createMiniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-07-01', bindings: { ACCESS_KEY: key }, durableObjects: { AUTH_GUARD: { className: 'AuthGuard', useSQLite: true }, SSH_SESSIONS: { className: 'SSHSessionDO', useSQLite: true }, MCP_SSH: { className: 'MCPSSHSession', useSQLite: true } } });
after(async () => { await mf.dispose(); for (const peer of peers) peer.end(); await new Promise(resolve => server.close(resolve)); });
let sequence = 1;
async function call(name, args) {
  const response = await mf.dispatchFetch('https://example.com/mcp', { method: 'POST', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.25' }, body: JSON.stringify({ jsonrpc: '2.0', id: sequence++, method: 'tools/call', params: { name, arguments: args } }) });
  const message = await response.json();
  assert.equal(response.status, 200);
  return message.result;
}
const args = { host: '1.1.1.1', port: 22, username: 'test', authMethod: 'password', password: 'fixture-only', expectedFingerprint: fingerprint };
test('MCP completes real SSH handshake, sends input, drains output and closes', { timeout: 45000 }, async () => {
  const connected = await call('ssh_connect', args);
  assert.equal(connected.isError, undefined, JSON.stringify(connected));
  const { connectionId } = JSON.parse(connected.content[0].text);
  assert.match(connectionId, /^[a-f0-9]{64}$/);
  const sent = await call('ssh_send', { connectionId, data: 'echo MCP_OK\n' });
  assert.equal(sent.isError, undefined, JSON.stringify(sent));
  let output = '';
  const deadline = Date.now() + 5000;
  while (!output.includes('received: echo MCP_OK') && Date.now() < deadline) {
    const read = await call('ssh_read', { connectionId });
    assert.equal(read.isError, undefined);
    output += JSON.parse(read.content[0].text).output;
    if (!output.includes('received: echo MCP_OK')) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.match(output, /received: echo MCP_OK/);
  assert.equal((await call('ssh_disconnect', { connectionId })).isError, undefined);
  assert.equal((await call('ssh_send', { connectionId, data: 'no\n' })).isError, true);
});
test('changed host fingerprint is rejected before credentials are sent', { timeout: 45000 }, async () => {
  const before = authAttempts;
  const result = await call('ssh_connect', { ...args, expectedFingerprint: `SHA256:${'a'.repeat(43)}` });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /fingerprint mismatch/);
  assert.equal(authAttempts, before);
});
test('wrong SSH password returns a tool error', { timeout: 45000 }, async () => {
  const result = await call('ssh_connect', { ...args, password: 'incorrect' });
  assert.equal(result.isError, true);
});

for (const [format, privateKey] of [['RSA PKCS#1 PEM', rsaPem], ['RSA PKCS#8 PEM', rsaPkcs8]]) {
  test(`${format} authenticates through the real SSH server`, { timeout: 45000 }, async () => {
    const { password, ...connection } = args;
    const connected = await call('ssh_connect', { ...connection, authMethod: 'publickey', privateKey });
    assert.equal(connected.isError, undefined, JSON.stringify(connected));
    const { connectionId } = JSON.parse(connected.content[0].text);
    assert.equal((await call('ssh_send', { connectionId, data: 'echo KEY_OK\n' })).isError, undefined);
    assert.equal((await call('ssh_disconnect', { connectionId })).isError, undefined);
  });
}
test('encrypted and malformed RSA PEM keys are rejected', { timeout: 45000 }, async () => {
  const { password, ...connection } = args;
  const encrypted = identity.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'fixture-passphrase' });
  for (const privateKey of [encrypted, '-----BEGIN RSA PRIVATE KEY-----\nYWJj\n-----END RSA PRIVATE KEY-----']) {
    const result = await call('ssh_connect', { ...connection, authMethod: 'publickey', privateKey });
    assert.equal(result.isError, true);
  }
});
