import { connect } from 'cloudflare:sockets';
import { SSHSession } from './backend/session';
import { assertPublicTarget, toSocketHostname } from './backend/security';
import type { SSHConnectionConfig } from './types';

// Fixed, read-only Linux probe. No caller supplied command or shell interpolation.
export const INSPECT_COMMAND = `set -e; LC_ALL=C; export LC_ALL; printf '__VPS_TIME1__\\n'; cat /proc/uptime; printf '__VPS_CPU1__\\n'; head -n 1 /proc/stat; printf '__VPS_NET1__\\n'; cat /proc/net/dev; sleep 1; printf '__VPS_TIME2__\\n'; cat /proc/uptime; printf '__VPS_CPU2__\\n'; head -n 1 /proc/stat; printf '__VPS_NET2__\\n'; cat /proc/net/dev; printf '__VPS_MEMORY__\\n'; cat /proc/meminfo; printf '__VPS_LOAD__\\n'; cat /proc/loadavg; printf '__VPS_DISK__\\n'; df -Pk; printf '__VPS_END__\\n'`;
export function parseInspection(output: string) {
  const section = (name: string): string => output.split(`__VPS_${name}__\n`)[1]?.split('__VPS_')[0]?.trim() ?? '';
  if (!output.includes('__VPS_END__') || !section('CPU1') || !section('CPU2') || !section('MEMORY') || !section('LOAD') || !section('DISK')) throw new Error('Incomplete Linux inspection data');
  const cpu = (name: string) => section(name).split(/\s+/).slice(1).map(Number).slice(0, 8);
  const first = cpu('CPU1'), second = cpu('CPU2');
  if (first.length < 5 || second.length < 5 || [...first, ...second].some(n => !Number.isFinite(n))) throw new Error('Invalid CPU inspection data');
  const delta = second.map((n, i) => n - first[i]);
  const total = delta.reduce((a, b) => a + b, 0);
  const memory = Object.fromEntries(section('MEMORY').split('\n').map(line => { const [key, value] = line.split(/:\s*/); return [key, Number.parseInt(value) * 1024]; }));
  const network = (name: string) => Object.fromEntries(section(name).split('\n').filter(line => line.includes(':')).map(line => { const [iface, data] = line.split(':'); const values = data.trim().split(/\s+/).map(Number); return [iface.trim(), { received: values[0], sent: values[8] }]; }));
  const before = network('NET1'), after = network('NET2');
  const sampleSeconds = Number.parseFloat(section('TIME2')) - Number.parseFloat(section('TIME1'));
  if (!Number.isFinite(sampleSeconds) || sampleSeconds <= 0 || !Number.isFinite(memory.MemTotal) || !Object.keys(after).length) throw new Error('Incomplete memory or network inspection data');
  return {
    sampledAt: Date.now(), sampleSeconds,
    cpu: { percent: total > 0 ? Math.max(0, Math.min(100, (1 - (delta[3] + delta[4]) / total) * 100)) : null },
    memory: { totalBytes: memory.MemTotal, availableBytes: memory.MemAvailable ?? memory.MemFree, swapTotalBytes: memory.SwapTotal, swapFreeBytes: memory.SwapFree },
    load: section('LOAD').split(/\s+/).slice(0, 3).map(Number),
    disks: section('DISK').split('\n').slice(1).map(line => { const fields = line.trim().split(/\s+/); return { filesystem: fields[0], totalBytes: Number(fields[1]) * 1024, usedBytes: Number(fields[2]) * 1024, availableBytes: Number(fields[3]) * 1024, percent: Number.parseFloat(fields[4]), mount: fields.slice(5).join(' ') }; }),
    network: Object.entries(after).filter(([iface]) => before[iface]).map(([iface, value]) => ({ interface: iface, receivedBytes: value.received, sentBytes: value.sent, receiveBytesPerSecond: Math.max(0, (value.received - before[iface].received) / sampleSeconds), sendBytesPerSecond: Math.max(0, (value.sent - before[iface].sent) / sampleSeconds) })),
  };
}
/** A single request owns every resource; no handles, alarms, polling or DO sessions. */
export async function inspectServer(config: SSHConnectionConfig, signal?: AbortSignal) {
  if (!config.expectedFingerprint) throw new Error('A verified server fingerprint is required before inspection');
  let socket: ReturnType<typeof connect> | undefined;
  let session: SSHSession | undefined;
  let pair: { 0: WebSocket; 1: WebSocket } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  let output = '';
  let finished = false;
  const decoder = new TextDecoder();
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Inspection timed out after 20 seconds')), 20_000);
        cancel = () => reject(new Error('Inspection cancelled'));
        if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
      }),
      (async () => {
        const addresses = await assertPublicTarget(config.host);
        if (finished || signal?.aborted) throw new Error('Inspection cancelled');
        socket = connect({ hostname: toSocketHostname(addresses[0]), port: config.port }, { secureTransport: 'off', allowHalfOpen: false });
        await socket.opened;
        if (finished) throw new Error('Inspection cancelled');
        pair = new WebSocketPair();
        pair[0].binaryType = 'arraybuffer'; pair[0].accept(); pair[1].accept();
        session = new SSHSession(pair[1], socket, { ...config }, INSPECT_COMMAND);
        return await new Promise<ReturnType<typeof parseInspection>>((resolve, reject) => {
          pair![0].addEventListener('message', event => {
            if (typeof event.data !== 'string') {
              output += decoder.decode(event.data, { stream: true });
              if (output.length > 256 * 1024) reject(new Error('Inspection output exceeds 256 KiB'));
              return;
            }
            try {
              const frame = JSON.parse(event.data);
              if (frame.type === 'host_key' && frame.trusted !== true) reject(new Error('SSH host fingerprint mismatch'));
              if (frame.type === 'error') reject(new Error('SSH inspection failed; check credentials, fingerprint and Linux probe support'));
              if (frame.type === 'status' && frame.event === 'session_ended') resolve(parseInspection(output));
            } catch (error) { reject(error); }
          });
          pair![0].addEventListener('close', () => { try { resolve(parseInspection(output)); } catch (error) { reject(error); } });
          pair![0].addEventListener('error', () => reject(new Error('SSH transport error')));
          void session!.start().catch(reject);
        });
      })(),
    ]);
  } finally {
    finished = true;
    if (timer) clearTimeout(timer);
    if (cancel) signal?.removeEventListener('abort', cancel);
    session?.close(true);
    for (const ws of pair ? Object.values(pair) : []) { try { ws.close(1000, 'Inspection complete'); } catch { /* already closed */ } }
    await socket?.close().catch(() => undefined);
  }
}
