export interface SavedKey { id: string; name: string; updatedAt: number }
export async function keyApi<T>(query = '', init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/keys${query}`, { ...init, cache: 'no-store', headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '密钥仓库操作失败');
  return data as T;
}
export function mountKeySelector(input: HTMLTextAreaElement, error: (message: string) => void) {
  const field = document.getElementById('key-field')!;
  const label = document.createElement('label'); label.className = 'field'; label.textContent = '已保存的密钥';
  const select = document.createElement('select'); select.id = 'saved-key-select'; select.setAttribute('aria-label', '已保存的密钥'); label.append(select);
  const nameLabel = document.createElement('label'); nameLabel.className = 'field'; nameLabel.textContent = '新密钥名称';
  const name = document.createElement('input'); name.id = 'saved-key-name'; name.maxLength = 64; name.placeholder = '例如：通用运维密钥'; nameLabel.append(name);
  field.prepend(label, nameLabel);
  const privateLabel = input.closest('label')!; const file = field.querySelector<HTMLElement>('.file-picker')!;
  const show = () => { const saved = Boolean(select.value); privateLabel.hidden = saved; file.hidden = saved; nameLabel.hidden = saved; };
  async function refresh(): Promise<void> {
    const previous = select.value;
    const { keys } = await keyApi<{ keys: SavedKey[] }>();
    select.replaceChildren(new Option('导入新密钥（加密保存后可复用）', ''));
    for (const key of keys) select.append(new Option(key.name, key.id));
    select.value = previous; show();
  }
  select.addEventListener('change', () => {
    input.value = ''; show();
    if (select.value) {
      const id = select.value;
      void keyApi<{ key: { privateKey: string } }>(`?id=${encodeURIComponent(id)}`).then(({ key }) => { if (select.value === id) input.value = key.privateKey; }).catch(e => error(String(e)));
    }
  });
  return {
    refresh,
    async set(id = ''): Promise<void> { await refresh(); select.value = id; show(); },
    async ensureSaved(fallbackName: string): Promise<string> {
      if (select.value) return select.value;
      if (!input.value.trim()) throw new Error('请选择已保存的密钥，或导入一把新密钥。');
      const id = crypto.randomUUID();
      await keyApi('', { method: 'PUT', body: JSON.stringify({ id, name: name.value.trim() || `${fallbackName} 密钥`, privateKey: input.value }) });
      await refresh(); select.value = id; show(); return id;
    },
  };
}
