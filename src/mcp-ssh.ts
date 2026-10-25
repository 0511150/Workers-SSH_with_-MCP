import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import { SSHSession } from './backend/session';
import { assertPublicTarget, toSocketHostname } from './backend/security';
import { parseConnectMessage, type Env, type SSHConnectionConfig } from './types';

/** Each MCP handle owns one SSH connection, never credentials in durable storage. */
export class MCPSSHSession extends DurableObject<Env> {
  private session: SSHSession | null = null;
  private pair: { 0: WebSocket; 1: WebSocket } | null = null;
  private output = '';
  private truncated = false;
  private closed = true;
  private opening = false;
  private expiresAt = 0;
  private readonly decoder = new TextDecoder();
  async open(raw: unknown): Promise<{ connected: true }> {
    if (this.opening || this.session) throw new Error('Session already opened');
    const config = parseConnectMessage(raw);
    if (!config.expectedFingerprint) throw new Error('Verified expectedFingerprint is required');
    this.opening = true;
    try {
      const addresses = await assertPublicTarget(config.host);
      await this.startSSH(addresses, config);
      this.expiresAt = Date.now() + 900_000;
      await this.ctx.storage.setAlarm(this.expiresAt);
      return { connected: true };
    } catch (error) { this.close(); throw error; }
    finally { this.opening = false; }
  }
  private async startSSH(addresses: string[], config: SSHConnectionConfig): Promise<void> {
    // Only use a DNS-validated literal address, preserving the upstream SSRF checks.
    const socket = connect({ hostname: toSocketHostname(addresses[0]), port: config.port }, { secureTransport: 'off', allowHalfOpen: false });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([socket.opened, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('TCP connection timed out')), 10_000); })]);
    } catch (error) { await socket.close().catch(() => undefined); throw error; }
    finally { if (timer) clearTimeout(timer); }
    const pair = new WebSocketPair();
    this.pair = pair;
    pair[0].binaryType = 'arraybuffer';
    pair[0].accept();
    pair[1].accept();
    this.session = new SSHSession(pair[1], socket, config);
    this.closed = false;
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('SSH handshake timed out')), 30_000);
      const finish = (error?: Error): void => { clearTimeout(deadline); error ? reject(error) : resolve(); };
      pair[0].addEventListener('message', event => {
        if (typeof event.data !== 'string') {
          this.output += this.decoder.decode(event.data, { stream: true });
          if (this.output.length > 262144) { this.output = this.output.slice(-262144); this.truncated = true; }
          return;
        }
        const frame = JSON.parse(event.data) as Record<string, unknown>;
        if (frame.type === 'ready') finish();
        if (frame.type === 'host_key' && frame.trusted !== true) {
          // A changed fingerprint must never be silently accepted.
          void this.session?.handleClientMessage(JSON.stringify({ type: 'host_key_decision', fingerprint: frame.fingerprint, accept: false })).catch(() => undefined);
          finish(new Error('SSH host fingerprint mismatch'));
          this.close();
        }
        if (frame.type === 'error') finish(new Error('SSH connection failed; verify host, credentials and fingerprint'));
      });
      pair[0].addEventListener('close', () => { this.closed = true; finish(new Error('SSH connection closed')); });
      pair[0].addEventListener('error', () => { this.closed = true; finish(new Error('SSH transport error')); });
      this.session!.start().catch(error => finish(error instanceof Error ? error : new Error('SSH start failed')));
    });
  }
  async send(data: string): Promise<{ sent: true }> {
    if (Date.now() >= this.expiresAt) this.close();
    if (!this.session || this.closed) throw new Error('SSH session closed or restarted; reconnect');
    if (typeof data !== 'string' || data.length > 65536) throw new Error('Input exceeds 64 KiB');
    await this.session.handleClientMessage(JSON.stringify({ type: 'input', data }));
    return { sent: true };
  }
  read(): { output: string; closed: boolean; truncated: boolean } {
    if (Date.now() >= this.expiresAt) this.close();
    if (!this.session) throw new Error('SSH session closed or restarted; reconnect');
    const result = { output: this.output, closed: this.closed, truncated: this.truncated };
    this.output = ''; this.truncated = false;
    return result;
  }
  close(): { closed: true } {
    this.session?.close(true);
    this.session = null;
    this.closed = true;
    for (const ws of this.pair ? Object.values(this.pair) : []) { try { ws.close(1000, 'Session closed'); } catch { /* already closed */ } }
    return { closed: true };
  }
  async alarm(): Promise<void> { this.close(); await this.ctx.storage.deleteAll(); }
}
