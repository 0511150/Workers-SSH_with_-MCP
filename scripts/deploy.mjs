import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { validSecret } from '../src/auth-policy.ts';
let secret = process.env.ACCESS_KEY;
if (!secret) {
  try { secret = (await readFile('.dev.vars', 'utf8')).match(/^ACCESS_KEY=(.*)$/m)?.[1]?.trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
// In Workers Builds the ACCESS_KEY binding can be supplied by the deployment UI.
// Runtime validation still fails closed if the binding is missing or too short.
if (secret !== undefined && !validSecret(secret)) throw new Error('ACCESS_KEY 至少需要 10 位，推荐 32 位以上随机密码。');
const file = `.secrets.${randomUUID()}.json`;
try {
  const args = ['node_modules/wrangler/bin/wrangler.js', 'deploy'];
  if (secret) { await writeFile(file, JSON.stringify({ ACCESS_KEY: secret }), { mode: 0o600 }); args.push('--secrets-file', file); }
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  process.exitCode = result.status ?? 1;
} finally { if (secret) await unlink(file); }
