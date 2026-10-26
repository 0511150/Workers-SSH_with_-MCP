import { parseConnectMessage, type SSHConnectionConfig } from './types';

export interface ServerRecord extends SSHConnectionConfig {
  id: string;
  name: string;
  updatedAt: number;
}
export function parseServer(value: unknown): ServerRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid server');
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(raw.id)) throw new Error('Invalid server ID');
  const { id, name, updatedAt: _updatedAt, ...connection } = raw;
  if (name !== undefined && (typeof name !== 'string' || name.length > 64)) throw new Error('Invalid server name');
  const config = parseConnectMessage({ ...connection, type: 'connect' });
  // Keep each encrypted record within the Durable Object KV value limit.
  if (new TextEncoder().encode(JSON.stringify(config)).length > 90 * 1024) throw new Error('Server credentials exceed 90 KiB');
  return { ...config, id, name: typeof name === 'string' ? name : config.host, updatedAt: Date.now() };
}
export function serverSummary(server: ServerRecord) {
  const { id, name, host, port, username, authMethod, expectedFingerprint, updatedAt } = server;
  return { id, name, host, port, username, authMethod, expectedFingerprint, updatedAt };
}
async function vaultKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('workers-ssh-vault-v1'), info: new TextEncoder().encode('server-credentials') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function sealServer(server: ServerRecord, secret: string): Promise<{ iv: Uint8Array; data: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(server.id) }, await vaultKey(secret), new TextEncoder().encode(JSON.stringify(server)));
  return { iv, data };
}
export async function openServer(id: string, encrypted: { iv: Uint8Array; data: ArrayBuffer }, secret: string): Promise<ServerRecord> {
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(encrypted.iv), additionalData: new TextEncoder().encode(id) }, await vaultKey(secret), encrypted.data);
  return JSON.parse(new TextDecoder().decode(data)) as ServerRecord;
}
