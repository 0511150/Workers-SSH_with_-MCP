export interface RemoteServer {
  id: string; name: string; host: string; port: number; username: string;
  authMethod: 'password' | 'publickey'; password?: string; privateKey?: string;
  expectedFingerprint?: string; updatedAt: number;
}
export async function serverApi<T>(query = '', init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/servers${query}`, { ...init, cache: 'no-store', headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '无法读取服务器仓库');
  return data as T;
}
