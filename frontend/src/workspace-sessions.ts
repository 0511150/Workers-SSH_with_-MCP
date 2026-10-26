import type { HistoryEntry } from './history';

interface Entry { id: string; host: HistoryEntry; frame: HTMLIFrameElement; tab: HTMLButtonElement; state: string }
/** Separate documents isolate the existing terminal, socket and auxiliary managers. */
export function mountWorkspaceSessions(shell: HTMLElement, changed: (host?: HistoryEntry) => void) {
  const embedded = location.pathname === '/session-view';
  const stage = document.createElement('section'); stage.className = 'multi-session-stage'; stage.hidden = true;
  const tabs = document.createElement('div'); tabs.className = 'session-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '服务器终端');
  const views = document.createElement('div'); views.className = 'session-views'; stage.append(tabs, views);
  if (!embedded) shell.append(stage);
  const entries = new Map<string, Entry>(); let active: string | null = null; let fontSize = 13;
  const appearance = (frame: HTMLIFrameElement): void => { frame.contentWindow?.postMessage({ type: 'workspace-theme', theme: document.documentElement.dataset.theme }, location.origin); frame.contentWindow?.postMessage({ type: 'workspace-font', size: fontSize }, location.origin); };
  if (!embedded) {
    new MutationObserver(() => { for (const entry of entries.values()) appearance(entry.frame); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    document.addEventListener('switch-font-size', event => { fontSize = (event as CustomEvent<number>).detail; for (const entry of entries.values()) appearance(entry.frame); });
  }
  function activate(id: string): void {
    active = id;
    for (const entry of entries.values()) {
      const selected = entry.id === id; entry.frame.hidden = !selected;
      entry.tab.setAttribute('aria-selected', String(selected)); entry.tab.tabIndex = selected ? 0 : -1;
    }
    const entry = entries.get(id); if (entry) { entry.frame.contentWindow?.postMessage({ type: 'workspace-resize' }, location.origin); changed(entry.host); }
  }
  function close(id: string): void {
    const entry = entries.get(id); if (!entry) return;
    entry.frame.contentWindow?.postMessage({ type: 'workspace-close' }, location.origin);
    entry.frame.remove(); entry.tab.parentElement?.remove(); entries.delete(id);
    if (active === id) { active = null; const next = [...entries.keys()].at(-1); if (next) activate(next); }
    stage.hidden = !entries.size; shell.classList.toggle('has-terminal-sessions', entries.size > 0); changed();
  }
  window.addEventListener('message', event => {
    if (embedded || event.origin !== location.origin) return;
    const entry = [...entries.values()].find(e => e.frame.contentWindow === event.source);
    if (!entry) return;
    if (event.data?.type === 'workspace-state' && typeof event.data.state === 'string') {
      entry.state = event.data.state; entry.tab.dataset.state = entry.state; changed();
    }
    if (event.data?.type === 'workspace-close-request') close(entry.id);
  });
  return {
    embedded,
    open(host: HistoryEntry, name: string, files = false): void {
      const existing = entries.get(host.id);
      if (existing && !['idle', 'error'].includes(existing.state)) { activate(existing.id); existing.frame.contentWindow?.postMessage({ type: 'workspace-view', files }, location.origin); return; }
      if (existing) close(existing.id);
      const frame = document.createElement('iframe'); frame.title = `${name} · SSH 终端`; frame.className = 'terminal-session-frame';
      frame.addEventListener('load', () => appearance(frame));
      frame.src = `/session-view?id=${encodeURIComponent(host.id)}${files ? '&files=1' : ''}`;
      const row = document.createElement('div'); row.className = 'session-tab-wrap';
      const tab = document.createElement('button'); tab.type = 'button'; tab.setAttribute('role', 'tab'); tab.textContent = name; tab.dataset.state = 'connecting'; tab.onclick = () => activate(host.id);
      tab.onkeydown = event => {
        const ids = [...entries.keys()]; const index = ids.indexOf(host.id);
        const next = event.key === 'ArrowRight' ? ids[(index + 1) % ids.length] : event.key === 'ArrowLeft' ? ids[(index - 1 + ids.length) % ids.length] : event.key === 'Home' ? ids[0] : event.key === 'End' ? ids.at(-1) : undefined;
        if (next) { event.preventDefault(); activate(next); entries.get(next)?.tab.focus(); }
      };
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'session-tab-close'; remove.textContent = '×'; remove.setAttribute('aria-label', `关闭 ${name} 终端`); remove.onclick = () => close(host.id);
      row.append(tab, remove); tabs.append(row); views.append(frame);
      entries.set(host.id, { id: host.id, host, frame, tab, state: 'connecting' });
      shell.classList.add('has-terminal-sessions'); stage.hidden = false; activate(host.id);
    },
    prune(ids: Set<string>): void { for (const id of [...entries.keys()]) if (!ids.has(id)) close(id); },
    closeActive(): void { if (active) close(active); },
    closeHost(id: string): void { close(id); },
    state(id: string): string { return entries.get(id)?.state ?? 'idle'; },
    activeHost(): HistoryEntry | null { return active ? entries.get(active)?.host ?? null : null; },
  };
}
