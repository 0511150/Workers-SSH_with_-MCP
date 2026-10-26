import type { HistoryEntry } from './history';
import './switch-workspace.css';

interface Bridge {
  hosts(): HistoryEntry[];
  name(host: HistoryEntry): string;
  select(host: HistoryEntry): Promise<void>;
  save(): Promise<void>;
  remove(id: string): Promise<void>;
  connect(): Promise<void>;
  panel(open: boolean): void;
  tab(tab: 'files' | 'network' | 'processes' | 'log' | null): void;
  state(): string;
  target(): string;
  resize(): void;
}
interface HostMeta { name: string; role: string; tags: string[]; favorite: boolean }
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const button = (text: string, action: () => void, className = 'switch-button'): HTMLButtonElement => {
  const node = document.createElement('button'); node.type = 'button'; node.className = className; node.textContent = text; node.onclick = action; return node;
};
export function mountSwitchWorkspace(bridge: Bridge): { refresh(): void } {
  let selected: HistoryEntry | null = null;
  let filter = '';
  let favoriteOnly = false;
  let view: 'hosts' | 'terminal' | 'files' | 'settings' = 'terminal';
  let meta: Record<string, HostMeta> = {};
  try { meta = JSON.parse(localStorage.getItem('workers-ssh.host-meta') ?? '{}'); } catch { /* Browser metadata is optional. */ }
  const persist = (): void => { try { localStorage.setItem('workers-ssh.host-meta', JSON.stringify(meta)); } catch { status('浏览器未允许保存主机备注。'); } };
  const info = (host: HistoryEntry): HostMeta => meta[host.id] ?? { name: bridge.name(host), role: '未标记', tags: [], favorite: false };
  const shell = $('app-shell');
  shell.classList.add('switch-shell'); shell.dataset.view = view;
  const oldPanel = $('connection-panel');
  const editor = document.createElement('dialog'); editor.id = 'switch-editor'; editor.className = 'switch-dialog';
  editor.innerHTML = '<div class="switch-dialog-heading"><h2>主机连接</h2><button type="button" id="switch-editor-close" aria-label="关闭主机编辑">×</button></div>';
  document.body.append(editor); editor.append(oldPanel);
  const nameField = document.createElement('label'); nameField.className = 'switch-name-field'; nameField.textContent = '主机名称';
  const nameInput = document.createElement('input'); nameInput.id = 'switch-host-name'; nameInput.maxLength = 64; nameInput.placeholder = '例如：生产服务器 / 香港节点'; nameField.append(nameInput); editor.insertBefore(nameField, oldPanel);
  oldPanel.querySelector('.profiles-section')?.setAttribute('hidden', '');
  oldPanel.querySelector('.panel-heading')?.setAttribute('hidden', '');
  const saveButton = button('保存到主机仓库', () => { const previousMeta = selected ? info(selected) : null; void bridge.save().then(() => {
    const saved = bridge.hosts().find(h => h.host === $<HTMLInputElement>('host').value.trim() && h.username === $<HTMLInputElement>('username').value.trim() && h.port === Number($<HTMLInputElement>('port').value));
    if (saved) { meta[saved.id] = { ...(previousMeta ?? info(saved)), name: nameInput.value.trim() || saved.host }; selected = saved; persist(); }
    editor.close(); refresh();
  }).catch(error => status(error instanceof Error ? error.message : '保存失败')); }, 'switch-button switch-save');
  $('connection-form').append(saveButton);
  $('switch-editor-close').onclick = () => editor.close();
  editor.addEventListener('close', () => bridge.panel(false));
  editor.addEventListener('click', event => { if (event.target === editor) editor.close(); });
  const openEditor = (fresh = false): void => {
    nameInput.value = fresh ? '' : selected ? info(selected).name : '';
    if (fresh) {
      for (const id of ['profile-id', 'host', 'password', 'private-key', 'fingerprint', 'initial-command']) ($<HTMLInputElement>(id)).value = '';
      $<HTMLInputElement>('port').value = '22'; $<HTMLInputElement>('username').value = 'root'; selected = null;
    }
    bridge.panel(true); if (!editor.open) editor.showModal();
    requestAnimationFrame(() => $<HTMLInputElement>('host').focus());
  };
  // Keep the existing connection controls and cryptographic credential storage.
  $('panel-toggle').addEventListener('click', () => openEditor());
  $('empty-connect').addEventListener('click', () => openEditor());
  $('connection-form').addEventListener('submit', () => { if ($<HTMLInputElement>('host').value.trim() && $('form-error').hidden) { editor.close(); setView('terminal'); } });

  const warehouse = document.createElement('aside'); warehouse.id = 'switch-hosts'; warehouse.className = 'switch-hosts';
  warehouse.innerHTML = '<div class="switch-host-heading"><div><span class="switch-eyebrow">YOUR INFRASTRUCTURE</span><h1>主机仓库 <span id="switch-count">0</span></h1></div><button type="button" id="switch-add-small" aria-label="添加主机">＋</button></div><div class="switch-host-filter"><input id="switch-search" type="search" placeholder="搜索名称 / IP / 标签" aria-label="搜索主机"><button id="switch-favorite-filter" type="button" aria-label="只看收藏">☆</button></div><div id="switch-host-list" class="switch-host-list"></div><div class="switch-host-footer"><span class="switch-dot"></span> SSH + MCP · 私人工作台</div>';
  shell.prepend(warehouse);
  const inspector = document.createElement('aside'); inspector.id = 'switch-inspector'; inspector.className = 'switch-inspector';
  inspector.innerHTML = `<div class="switch-inspector-heading"><strong id="switch-detail-name">主机详情</strong><button type="button" id="switch-detail-refresh">刷新</button></div>
    <div class="switch-detail-scroll"><section class="switch-card switch-identity"><div class="switch-os-icon">⌘</div><div><strong id="switch-detail-os">尚未选择主机</strong><p id="switch-detail-address">从左侧选择主机查看详情</p></div><span class="switch-chip" id="switch-detail-auth">SSH</span><div class="switch-identity-metrics"><div>连接状态<strong id="switch-detail-state">未连接</strong></div><div>认证方式<strong id="switch-auth-mode">—</strong></div><div>端口<strong id="switch-detail-port">—</strong></div></div></section>
    <section class="switch-card"><h3>CPU 算力与负载 <span class="switch-chip">实时</span></h3><div id="switch-cpu-slot"></div></section>
    <section class="switch-card"><h3>内存结构 <span>RAM & Swap</span></h3><div id="switch-memory-slot"></div></section>
    <section class="switch-card"><h3>网络吞吐 <span>SSH 会话</span></h3><div id="switch-network-slot"></div><p class="switch-hint">连接后显示实时数据，未连接时不进行轮询。</p></section>
    <section class="switch-card"><h3>主机身份</h3><div id="switch-session-slot"></div><p class="switch-hint" id="switch-fingerprint">连接后核验服务器 SHA-256 指纹。</p></section>
    <section class="switch-card"><h3>角色分类</h3><div id="switch-roles" class="switch-roles"></div><h3>标签</h3><div id="switch-tags" class="switch-tags"></div><form id="switch-tag-form" class="switch-inline"><input id="switch-tag-input" placeholder="添加标签（回车保存）" maxlength="24" aria-label="主机标签"><button type="submit">添加</button></form></section></div>
    <div class="switch-detail-actions"><button type="button" id="switch-open-terminal" class="switch-primary">打开终端</button><button type="button" id="switch-open-files">文件浏览</button><button type="button" id="switch-edit">编辑</button><button type="button" id="switch-delete" class="switch-danger">删除</button></div>`;
  shell.append(inspector);
  document.querySelector('.resource-cpu') && $('switch-cpu-slot').append(document.querySelector('.resource-cpu')!);
  for (const cls of ['.resource-memory', '.resource-swap']) { const node = document.querySelector(cls); if (node) $('switch-memory-slot').append(node); }
  const network = $('resource-network'); $('switch-network-slot').append(network);
  const sessionMetrics = document.querySelector('.session-metrics'); if (sessionMetrics) $('switch-session-slot').append(sessionMetrics);
  const top = document.querySelector('.topbar')!;
  document.querySelector('.brand span:last-child')!.textContent = 'Workers SSH';
  const actions = document.querySelector('.topbar-actions')!;
  actions.prepend(button('⚙', () => settings('general'), 'icon-button switch-settings-button'), button('＋', () => openEditor(true), 'switch-add'));
  $('switch-add-small').onclick = () => openEditor(true);
  const terminalActions = document.querySelector('.terminal-actions')!;
  terminalActions.prepend(button('文件管理', () => setView('files')));
  const settingsPage = document.createElement('section'); settingsPage.id = 'switch-settings'; settingsPage.className = 'switch-settings'; settingsPage.hidden = true;
  settingsPage.innerHTML = `<header class="switch-settings-heading"><div><h1>系统设置</h1><p>管理工作台偏好、MCP 接入与 Web 访问安全</p></div><button type="button" id="switch-settings-back">返回工作台</button></header><nav class="switch-settings-tabs" id="switch-settings-tabs"></nav><div id="switch-settings-body"></div>`;
  $('app').append(settingsPage);
  $('switch-settings-back').onclick = () => setView('hosts');
  const statusNode = document.createElement('div'); statusNode.className = 'switch-status'; statusNode.setAttribute('role', 'status'); document.body.append(statusNode);
  let statusTimer = 0;
  function status(text: string): void { statusNode.textContent = text; statusNode.classList.add('visible'); window.clearTimeout(statusTimer); statusTimer = window.setTimeout(() => statusNode.classList.remove('visible'), 3500); }
  function setView(next: typeof view): void {
    next = next === 'hosts' ? 'terminal' : next; view = next; shell.dataset.view = next; shell.hidden = next === 'settings'; settingsPage.hidden = next !== 'settings';
    if (next === 'files') bridge.tab('files'); else if (next === 'terminal') bridge.tab(null);

    requestAnimationFrame(bridge.resize);
  }
  async function openSelected(files = false): Promise<void> {
    if (!selected) { openEditor(true); return; }
    await bridge.select(selected);
    const active = bridge.state() === 'connected' && bridge.target() === selected.host;
    if (!active) {
      if (selected.authMethod === 'publickey' && !$<HTMLTextAreaElement>('private-key').value) { openEditor(); status('请选择此主机的私钥，保存主机后，私钥会加密存入服务器仓库。'); return; }
      if (bridge.state() !== 'idle' && bridge.state() !== 'error') { status('请先断开当前终端，再连接另一台主机。'); return; }
      await bridge.connect();
    }
    setView(files ? 'files' : 'terminal');
  }
  $('switch-search').addEventListener('input', () => { filter = $<HTMLInputElement>('switch-search').value.toLowerCase(); renderHosts(); });
  $('switch-favorite-filter').onclick = () => { favoriteOnly = !favoriteOnly; $('switch-favorite-filter').classList.toggle('active', favoriteOnly); renderHosts(); };
  $('switch-detail-refresh').onclick = () => { refresh(); status('已刷新连接状态；资源指标来自当前 SSH 会话。'); };
  $('switch-open-terminal').onclick = () => { void openSelected().catch(error => status(String(error))); };
  $('switch-open-files').onclick = () => { void openSelected(true).catch(error => status(String(error))); };
  $('switch-edit').onclick = () => { if (selected) void bridge.select(selected).then(() => openEditor()); else openEditor(true); };
  $('switch-delete').onclick = () => { if (selected && confirm(`删除主机“${info(selected).name}”？将从服务器仓库和本浏览器删除记录。`)) void bridge.remove(selected.id).then(() => { selected = null; refresh(); }).catch(error => status(String(error)));  };
  $('switch-tag-form').addEventListener('submit', event => {
    event.preventDefault(); if (!selected) return;
    const value = $<HTMLInputElement>('switch-tag-input').value.trim();
    if (value) { meta[selected.id] = { ...info(selected), tags: [...new Set([...info(selected).tags, value])].slice(0, 12) }; persist(); refresh(); }
    $<HTMLInputElement>('switch-tag-input').value = '';
  });
  function renderHosts(): void {
    const hosts = bridge.hosts().filter(h => (!favoriteOnly || info(h).favorite) && `${h.host} ${h.username} ${info(h).name} ${info(h).role} ${info(h).tags.join(' ')}`.toLowerCase().includes(filter));
    $('switch-count').textContent = String(bridge.hosts().length);
    const list = $('switch-host-list'); list.replaceChildren();
    if (!hosts.length) {
      const empty = document.createElement('div'); empty.className = 'switch-host-empty';
      const icon = document.createElement('span'); icon.textContent = '⌘';
      const heading = document.createElement('h2'); heading.textContent = bridge.hosts().length ? '没有匹配的主机' : '你的主机，从这里开始';
      const copy = document.createElement('p'); copy.textContent = '添加服务器后，即可打开终端、管理文件和查看连接详情。';
      empty.append(icon, heading, copy, button('＋ 添加主机', () => openEditor(true), 'switch-primary')); list.append(empty);
    }
    for (const host of hosts) {
      const details = info(host); const active = selected?.id === host.id;
      const card = document.createElement('article'); card.className = `switch-host-row${active ? ' selected' : ''}`;
      const online = bridge.target() === host.host && bridge.state() === 'connected';
      const choose = button('', () => { selected = host; void bridge.select(host); refresh(); }, 'switch-host-select');
      const os = document.createElement('span'); os.className = 'switch-host-os'; os.textContent = '>_';
      const copy = document.createElement('span'); copy.className = 'switch-host-copy';
      const name = document.createElement('strong'); const dot = document.createElement('i'); dot.className = `switch-dot${online ? ' online' : ''}`; dot.title = online ? '当前 SSH 会话在线' : '未连接'; name.append(dot, document.createTextNode(details.name));
      const address = document.createElement('small'); address.textContent = `${host.username}@${host.host}:${host.port}`;
      copy.append(name, address); choose.append(os, copy);
      const controls = document.createElement('div'); controls.className = 'switch-host-controls';
      controls.append(button('终端', () => { selected = host; void openSelected().catch(error => status(String(error))); }), button('文件', () => { selected = host; void openSelected(true).catch(error => status(String(error))); }), button(details.favorite ? '★' : '☆', () => { meta[host.id] = { ...details, favorite: !details.favorite }; persist(); renderHosts(); }, 'switch-star'), button('✎', () => { selected = host; void bridge.select(host).then(() => openEditor()); }, 'switch-star'));
      card.append(choose, controls); list.append(card);
    }
  }
  function refresh(): void {
    if (selected && !bridge.hosts().some(h => h.id === selected!.id)) selected = null;
    selected ??= bridge.hosts()[0] ?? null;
    renderHosts();
    const details = selected ? info(selected) : null;
    $('switch-detail-name').textContent = details?.name ?? '主机详情';
    $('switch-detail-os').textContent = selected ? details!.name : '尚未选择主机';
    $('switch-detail-address').textContent = selected ? `${selected.username}@${selected.host}` : '添加或选择主机，开始管理服务器';
    $('switch-detail-port').textContent = selected ? String(selected.port) : '—';
    $('switch-auth-mode').textContent = selected ? selected.authMethod === 'publickey' ? 'SSH 密钥' : '密码' : '—';
    const online = selected && bridge.target() === selected.host && bridge.state() === 'connected';
    $('switch-detail-state').textContent = online ? '在线' : '未连接';
    $('switch-fingerprint').textContent = selected?.fingerprint || '首次连接时核验主机指纹；不会自动信任未知主机。';
    for (const id of ['switch-cpu-slot','switch-memory-slot','switch-network-slot','switch-session-slot']) $(id).classList.toggle('switch-unselected-resource', !online);
    const roles = $('switch-roles'); roles.replaceChildren();
    for (const role of ['未标记', '主力', '代理', '测试', '归档']) roles.append(button(role, () => { if (selected) { meta[selected.id] = { ...info(selected), role }; persist(); refresh(); } }, `switch-role${details?.role === role ? ' active' : ''}`));
    const tags = $('switch-tags'); tags.replaceChildren();
    for (const tag of details?.tags ?? []) tags.append(button(`${tag} ×`, () => { if (selected) { meta[selected.id] = { ...info(selected), tags: info(selected).tags.filter(t => t !== tag) }; persist(); refresh(); } }, 'switch-chip'));
  }
  function settings(tab: string): void {
    setView('settings'); const nav = $('switch-settings-tabs'); nav.replaceChildren();
    for (const [id, label] of [['general','⚙ 常规'],['security','♙ 访问与 MCP'],['about','ⓘ 关于']]) nav.append(button(label, () => settings(id), `switch-setting-tab${id === tab ? ' active' : ''}`));
    const body = $('switch-settings-body'); body.replaceChildren();
    const card = document.createElement('section'); card.className = 'switch-settings-card'; body.append(card);
    if (tab === 'security') {
      card.innerHTML = '<h2>Web 访问保护</h2><p>访问密钥保存在 Cloudflare Secret；网页使用 HttpOnly、Secure 和 SameSite=Strict Cookie。</p><div class="switch-setting-grid"><div><h3>逐级 IP 封禁</h3><p>每 5 次认证失败升级一次</p><strong>1 分钟 → 15 分钟 → 24 小时 → 永久</strong></div><div><h3>主机身份验证</h3><p>首次连接需确认 SHA-256 指纹，MCP 检查使用仓库中已核验的指纹。</p></div></div><h3>管理员解除 IP 封禁</h3><form id="switch-unban" class="switch-inline"><input id="switch-unban-ip" placeholder="被封禁的 IP 地址" required aria-label="解除封禁的 IP"><button type="submit">解除封禁</button></form><p class="switch-hint">需要从未被封禁的 IP 操作。</p><p id="switch-unban-result" role="status"></p>';
      $('switch-unban').addEventListener('submit', event => { event.preventDefault(); void fetch('/api/admin/unban', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip: $<HTMLInputElement>('switch-unban-ip').value.trim() }) }).then(async r => { const data = await r.json(); $('switch-unban-result').textContent = r.ok ? '已解除封禁。' : data.error ?? '操作失败。'; }).catch(() => { $('switch-unban-result').textContent = '网络连接失败。'; }); });
      const mcpCard = document.createElement('section'); mcpCard.className = 'switch-settings-card'; body.append(mcpCard);
      mcpCard.innerHTML = '<h2>MCP 接入</h2><p>网页登录密码就是 MCP Bearer 密钥，共用同一套 IP 失败计数、逐级封禁与解封。无需设置第二个密钥。</p><code id="switch-mcp-url"></code><p>只提供 vps_list、vps_getdata、vps_inspect；每次请求独立完成。vps_getdata 会返回服务器密码或私钥，请仅交给可信客户端。</p><pre id="switch-config-preview"></pre><button type="button" id="switch-copy-config">复制接入示例</button>';
      $('switch-mcp-url').textContent = `${location.origin}/mcp`;
      const config = JSON.stringify({ mcpServers: { 'workers-ssh': { type: 'http', url: `${location.origin}/mcp`, headers: { Authorization: 'Bearer <网页登录密码>' } } } }, null, 2);
      $('switch-config-preview').textContent = config;
      $('switch-copy-config').onclick = () => { void navigator.clipboard.writeText(config).then(() => status('接入示例已复制，请填入同一个网页登录密码')); };
      const auditCard = document.createElement('section'); auditCard.className = 'switch-settings-card'; body.append(auditCard); renderAudit(auditCard);
    } else if (tab === 'about') {
      card.innerHTML = '<h2>Workers SSH</h2><p>运行在 Cloudflare Workers 上的私人 SSH 与 MCP 工作台。</p><div class="switch-setting-grid"><div><h3>WebSSH</h3><p>终端、SFTP、进程与网络管理。</p></div><div><h3>安全连接</h3><p>密钥鉴权、主机指纹验证和持久化逐级封禁。</p></div></div><p>工作台布局参考 VPS Switch，连接底座基于 CF-Workers-WebSSH。</p><a href="https://github.com/0511150/Workers-SSH_with_-MCP" target="_blank" rel="noopener noreferrer">查看源代码 ↗</a>';
    } else {
      card.innerHTML = '<h2>工作台偏好</h2><p>主机仓库和详情侧栏始终可用，不需要先打开终端。</p><div class="switch-setting-grid"><div><h3>颜色主题</h3><p>切换浅色或深色界面。</p><button type="button" id="switch-setting-theme">切换主题</button></div><div><h3>本地数据</h3><p>保存主机时，密码或私钥加密存入服务器仓库，供网页与 MCP 共用。旧的浏览器记录需重新保存一次。备注和标签保存在当前浏览器。</p></div></div><h3>终端显示</h3><label>字体大小 <input id="switch-font-size" type="range" min="11" max="20" value="13"></label><p>固定三栏工作台，中央切换终端和文件管理；当前版本保持一个活动 SSH 连接。</p>';
      $('switch-setting-theme').onclick = () => $('theme-toggle').click();
      $('switch-font-size').addEventListener('input', () => document.dispatchEvent(new CustomEvent('switch-font-size', { detail: Number($<HTMLInputElement>('switch-font-size').value) })));
    }
  }
  function renderAudit(card: HTMLElement): void {
    card.innerHTML = '<div class="switch-config-heading"><div><h2>访问与 MCP 记录</h2><p>最近 500 条登录、鉴权及工具调用元数据；不保存访问密钥、SSH 密码、私钥、命令正文或输出。</p></div><button type="button" id="switch-audit-refresh">刷新</button></div><div class="switch-audit-filters"><label>起始日期<input id="switch-audit-start" type="date"></label><label>结束日期<input id="switch-audit-end" type="date"></label><label>主机<select id="switch-audit-host"><option value="">全部主机</option></select></label><label>工具<select id="switch-audit-tool"><option value="">全部工具</option><option>web_login</option><option>web_auth</option><option>mcp_auth</option><option>vps_list</option><option>vps_getdata</option><option>vps_inspect</option></select></label><label>结果<select id="switch-audit-result"><option value="">全部</option><option value="true">成功</option><option value="false">失败</option></select></label></div><p id="switch-audit-status" role="status">正在读取记录…</p><div class="switch-audit-table"><table><thead><tr><th>时间</th><th>工具</th><th>主机</th><th>结果</th><th>耗时</th></tr></thead><tbody id="switch-audit-rows"></tbody></table></div><details class="switch-session-history"><summary>当前页面的 SSH 会话事件</summary><div id="switch-log-view"></div></details>';
    const lines = $('event-log').cloneNode(true) as HTMLElement; lines.removeAttribute('id'); lines.hidden = false; lines.className = 'switch-log-copy'; $('switch-log-view').append(lines);
    interface Row { id: string; timestamp: number; tool: string; host: string; success: boolean; duration: number }
    let rows: Row[] = [];
    const render = (): void => {
      if (!card.isConnected) return;
      const start = $<HTMLInputElement>('switch-audit-start').value;
      const end = $<HTMLInputElement>('switch-audit-end').value;
      const host = $<HTMLSelectElement>('switch-audit-host').value;
      const tool = $<HTMLSelectElement>('switch-audit-tool').value;
      const result = $<HTMLSelectElement>('switch-audit-result').value;
      const filtered = rows.filter(row => (!start || row.timestamp >= new Date(`${start}T00:00:00`).getTime()) && (!end || row.timestamp <= new Date(`${end}T23:59:59.999`).getTime()) && (!host || row.host === host) && (!tool || row.tool === tool) && (!result || String(row.success) === result));
      const tbody = $('switch-audit-rows'); tbody.replaceChildren();
      for (const row of filtered) {
        const tr = document.createElement('tr');
        for (const value of [new Date(row.timestamp).toLocaleString(), row.tool, row.host || '—', row.success ? '成功' : '失败', `${row.duration} ms`]) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
        tr.children[3].className = row.success ? 'switch-result-success' : 'switch-result-error'; tbody.append(tr);
      }
      $('switch-audit-status').textContent = rows.length ? `最近 ${rows.length} 条记录 · 当前显示 ${filtered.length} 条` : '暂无 MCP 工具调用记录；调用工具后会自动留痕。';
    };
    const load = async (): Promise<void> => {
      try {
        const response = await fetch('/api/audit', { cache: 'no-store' });
        if (!response.ok) throw new Error('无法读取调用记录，请确认登录仍有效。');
        const data = await response.json() as { calls: Row[] };
        if (!card.isConnected) return;
        rows = data.calls;
        const select = $<HTMLSelectElement>('switch-audit-host'); const previous = select.value;
        select.replaceChildren(new Option('全部主机', ''));
        for (const host of [...new Set(rows.map(row => row.host).filter(Boolean))]) select.append(new Option(host, host));
        select.value = previous; render();
      } catch (error) { if (card.isConnected) $('switch-audit-status').textContent = error instanceof Error ? error.message : '网络连接失败。'; }
    };
    for (const id of ['start','end','host','tool','result']) $(`switch-audit-${id}`).addEventListener('change', render);
    $('switch-audit-refresh').onclick = () => { void load(); };
    void load();
  }
  // Mirror existing live state, without probing inactive hosts or fabricating metrics.
  new MutationObserver(() => refresh()).observe($('session-title'), { childList: true, subtree: true });
  new MutationObserver(() => refresh()).observe($('live-orb'), { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setView('hosts'); $<HTMLInputElement>('switch-search').focus(); }
    if (event.key === 'Escape' && view === 'settings') setView('hosts');
  });
  refresh();
  return { refresh };
}
