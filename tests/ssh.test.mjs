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
let stallProbe = false;
const probeOutput = '__VPS_TIME1__\n100.00 50.00\n__VPS_CPU1__\ncpu 10 0 10 80 0 0 0 0\n__VPS_NET1__\neth0: 100 0 0 0 0 0 0 0 200 0\n__VPS_TIME2__\n101.00 50.00\n__VPS_CPU2__\ncpu 20 0 20 160 0 0 0 0\n__VPS_NET2__\neth0: 1100 0 0 0 0 0 0 0 2200 0\n__VPS_MEMORY__\nMemTotal: 1024 kB\nMemAvailable: 512 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n__VPS_LOAD__\n0.1 0.2 0.3 1/100 1\n__VPS_DISK__\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda 1000 200 800 20% /\n__VPS_END__\n';
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
    session.on('exec', (acceptExec, rejectExec, info) => {
      assert.match(info.command, /head -n 1 \/proc\/stat/);
      assert.match(info.command, /sleep 1/);
      const stream = acceptExec();
      if (stallProbe) return;
      stream.write(probeOutput);
      stream.exit(0); stream.end();
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
const mf = createMiniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-07-01', bindings: { ACCESS_KEY: key }, durableObjects: { AUTH_GUARD: { className: 'AuthGuard', useSQLite: true }, SSH_SESSIONS: { className: 'SSHSessionDO', useSQLite: true } } });
after(async () => { await mf.dispose(); for (const peer of peers) peer.end(); await new Promise(resolve => server.close(resolve)); });
let sequence = 1;
async function call(name, args) {
  const response = await mf.dispatchFetch('https://example.com/mcp', { method: 'POST', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.25' }, body: JSON.stringify({ jsonrpc: '2.0', id: sequence++, method: 'tools/call', params: { name, arguments: args } }) });
  const message = await response.json();
  assert.equal(response.status, 200);
  return message.result;
}
const args = { host: '1.1.1.1', port: 22, username: 'test', authMethod: 'password', password: 'fixture-only', expectedFingerprint: fingerprint };
async function inspect(connection) {
  const response = await mf.dispatchFetch('https://example.com/api/servers', { method: 'PUT', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...connection, id: 'ssh-fixture' }) });
  assert.equal(response.status, 200, await response.text());
  return call('vps_inspect', { id: 'ssh-fixture' });
}
async function assertClosed() {
  for (let i = 0; i < 100 && peers.size; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(peers.size, 0, 'temporary SSH connections must close after every request');
}
test('one-shot inspection returns all metrics and closes its real SSH connection', { timeout: 30000 }, async () => {
  const result = await inspect(args);
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const data = JSON.parse(result.content[0].text);
  assert.ok(Math.abs(data.cpu.percent - 20) < 0.01);
  assert.equal(data.memory.totalBytes, 1024 * 1024);
  assert.equal(data.disks[0].percent, 20);
  assert.equal(data.network[0].receiveBytesPerSecond, 1000);
  assert.deepEqual(data.load, [0.1, 0.2, 0.3]);
  assert.equal(data.connectionId, undefined);
  await assertClosed();
});

test('changed host fingerprint is rejected before credentials are sent', { timeout: 45000 }, async () => {
  const before = authAttempts;
  const result = await inspect( { ...args, expectedFingerprint: `SHA256:${'a'.repeat(43)}` });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /fingerprint mismatch/);
  assert.equal(authAttempts, before);
});
test('wrong SSH password returns a tool error', { timeout: 45000 }, async () => {
  const result = await inspect( { ...args, password: 'incorrect' });
  assert.equal(result.isError, true);
});

for (const [format, privateKey] of [['RSA PKCS#1 PEM', rsaPem], ['RSA PKCS#8 PEM', rsaPkcs8]]) {
  test(`${format} authenticates through the real SSH server`, { timeout: 45000 }, async () => {
    const { password, ...connection } = args;
    const connected = await inspect( { ...connection, authMethod: 'publickey', privateKey });
    assert.equal(connected.isError, undefined, JSON.stringify(connected));
    await assertClosed();
  });
}
test('encrypted and malformed RSA PEM keys are rejected', { timeout: 45000 }, async () => {
  const { password, ...connection } = args;
  const encrypted = identity.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'fixture-passphrase' });
  for (const privateKey of [encrypted, '-----BEGIN RSA PRIVATE KEY-----\nYWJj\n-----END RSA PRIVATE KEY-----']) {
    const result = await inspect( { ...connection, authMethod: 'publickey', privateKey });
    assert.equal(result.isError, true);
  }
});

test('private targets are rejected before opening TCP', async () => {
  const before = authAttempts;
  const result = await inspect({ ...args, host: '127.0.0.1' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Private and reserved/);
  assert.equal(authAttempts, before);
  await assertClosed();
});
test('a stalled inspection times out and closes TCP instead of retaining a session', { timeout: 30000 }, async () => {
  stallProbe = true;
  try {
    const result = await inspect(args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /timed out/);
    await assertClosed();
  } finally { stallProbe = false; }
});
