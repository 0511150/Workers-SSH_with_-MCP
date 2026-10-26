import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';
import { attempt, validSecret, type BanState } from './auth-policy';
import { jsonError, secureResponse } from './http-security';
import { openServer, parseServer, sealServer, serverSummary } from './server-vault';

export class AuthGuard extends DurableObject<Env> {
  async saveServer(raw: unknown): Promise<void> {
    const server = parseServer(raw);
    const encrypted = await sealServer(server, this.env.ACCESS_KEY);
    await this.ctx.storage.transaction(async tx => {
      const entries = await tx.list({ prefix: 'server:', limit: 101 });
      if (!entries.has(`server:${server.id}`) && entries.size >= 100) throw new Error('Server limit is 100');
      await tx.put(`server:${server.id}`, encrypted);
    });
  }
  async server(id: string) {
    const encrypted = await this.ctx.storage.get<Awaited<ReturnType<typeof sealServer>>>(`server:${id}`);
    if (!encrypted) throw new Error('Server not found');
    try { return await openServer(id, encrypted, this.env.ACCESS_KEY); }
    catch { throw new Error('Cannot decrypt server credentials with current ACCESS_KEY'); }
  }
  async servers() {
    const entries = await this.ctx.storage.list({ prefix: 'server:', limit: 100 });
    return Promise.all([...entries.keys()].map(async key => serverSummary(await this.server(key.slice(7)))));
  }
  async removeServer(id: string): Promise<void> { await this.ctx.storage.delete(`server:${id}`); }
  async recordCall(entry: { tool: string; host: string; success: boolean; duration: number }): Promise<void> {
    await this.ctx.storage.transaction(async tx => {
      const rows = await tx.get<unknown[]>('mcp-calls') ?? [];
      rows.push({ ...entry, id: crypto.randomUUID(), timestamp: Date.now() });
      const retained = rows.slice(-500);
      while (retained.length && new TextEncoder().encode(JSON.stringify(retained)).byteLength > 96 * 1024) retained.shift();
      await tx.put('mcp-calls', retained);
    });
  }
  async calls(): Promise<unknown[]> { return [...(await this.ctx.storage.get<unknown[]>('mcp-calls') ?? [])].reverse(); }
  async check(valid: boolean): Promise<{ allowed: boolean; blocked: boolean; until: number }> {
    return this.ctx.storage.transaction(async tx => {
      const previous = await tx.get<BanState>('ban') ?? { failures: 0, strikes: 0, until: 0 };
      const result = attempt(previous, valid, Date.now());
      await tx.put('ban', result.state);
      return { allowed: result.allowed, blocked: result.blocked, until: result.state.until };
    });
  }
  async unblock(): Promise<void> { await this.ctx.storage.delete('ban'); }
}
const encoder = new TextEncoder();
export async function sameSecret(candidate: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(candidate));
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(secret));
}
async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))), b => b.toString(16).padStart(2, '0')).join('');
}
export function clientIp(request: Request): string {
  // CF overwrites this header at the public edge. Do not trust X-Forwarded-For.
  return (request.headers.get('CF-Connecting-IP') ?? 'local').toLowerCase();
}
export async function cookieValid(request: Request, secret: string): Promise<boolean> {
  const token = request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('webssh_session='))?.slice(15);
  if (!token || token.length > 256) return false;
  const [expires, nonce, signature, extra] = token.split('.');
  if (extra !== undefined || !/^\d+$/.test(expires) || !/^[a-f0-9-]{36}$/.test(nonce ?? '') || !/^[a-f0-9]{64}$/.test(signature ?? '')) return false;
  if (Number(expires) <= Date.now() || Number(expires) > Date.now() + 86_400_000) return false;
  return sameSecret(signature, await sign(`${expires}.${nonce}`, secret));
}
export async function authenticate(request: Request, env: Env, bearerOnly = false, loginKey?: string): Promise<Response | null> {
  if (!validSecret(env.ACCESS_KEY)) return jsonError('请配置至少 10 位的 ACCESS_KEY，推荐 32 位以上随机密码。', 503);
  const bearer = request.headers.get('Authorization');
  const candidate = loginKey ?? (bearer?.startsWith('Bearer ') ? bearer.slice(7) : '');
  const valid = candidate.length <= 4096 && (loginKey !== undefined || bearer ? await sameSecret(candidate, env.ACCESS_KEY) : !bearerOnly && await cookieValid(request, env.ACCESS_KEY));
  const result = await env.AUTH_GUARD.getByName(clientIp(request)).check(valid);
  if (!result.allowed || loginKey !== undefined) {
    try { await env.AUTH_GUARD.getByName('__mcp-audit').recordCall({ tool: loginKey !== undefined ? 'web_login' : bearerOnly ? 'mcp_auth' : 'web_auth', host: '', success: result.allowed, duration: 0 }); }
    catch { console.error('Unable to persist authentication metadata'); }
  }
  if (result.blocked) return secureResponse(Response.json({ error: result.until === -1 ? '此 IP 已永久封禁，请联系管理员。' : '此 IP 已临时封禁。', until: result.until }, { status: 429, headers: { 'Cache-Control': 'no-store', ...(result.until === -1 ? {} : { 'Retry-After': String(Math.ceil((result.until - Date.now()) / 1000)) }) } }));
  return result.allowed ? null : secureResponse(Response.json({ error: '访问密钥无效。' }, { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="WebSSH MCP"', 'Cache-Control': 'no-store' } }));
}
export async function readJson(request: Request, max = 16384): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) { await reader.cancel(); throw new Error('Body too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function login(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('Origin') !== new URL(request.url).origin) return jsonError('Origin is not allowed', 403);
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return jsonError('Expected application/json', 415);
  let data: unknown;
  try { data = await readJson(request); } catch { return jsonError('Invalid or oversized request', 400); }
  const key = data && typeof data === 'object' && 'key' in data && typeof data.key === 'string' ? data.key : '';
  const rejected = await authenticate(request, env, true, key);
  if (rejected) return rejected;
  const payload = `${Date.now() + 86_400_000}.${crypto.randomUUID()}`;
  const token = `${payload}.${await sign(payload, env.ACCESS_KEY)}`;
  return secureResponse(Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store', 'Set-Cookie': `webssh_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400` } }));
}
