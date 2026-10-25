import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const setup = resolve('scripts/setup.mjs');
test('installer accepts only lengths >=10, generates requested random key and refuses overwrite', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'webssh-setup-test-'));
  for (const length of ['9', 'abc', '10.5', '4097']) {
    const result = spawnSync(process.execPath, [setup], { cwd, input: `${length}\n`, encoding: 'utf8' });
    assert.equal(result.status, 1);
  }
  const result = spawnSync(process.execPath, [setup], { cwd, input: '64\n', encoding: 'utf8' });
  assert.equal(result.status, 0);
  const stored = await readFile(join(cwd, '.dev.vars'), 'utf8');
  const key = stored.trim().slice('ACCESS_KEY='.length);
  assert.match(key, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(result.stdout.includes(key), false);
  assert.equal(spawnSync(process.execPath, [setup], { cwd, input: '10\n', encoding: 'utf8' }).status, 1);
  assert.equal(await readFile(join(cwd, '.dev.vars'), 'utf8'), stored);
});
test('deploy refuses a short secret before invoking Cloudflare', () => {
  const result = spawnSync(process.execPath, ['scripts/deploy.mjs'], { env: { ...process.env, ACCESS_KEY: 'short' }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /至少需要 10 位/);
});
