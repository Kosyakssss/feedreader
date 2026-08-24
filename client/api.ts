import type { Config, EnrichedEntry } from '../lib/types.ts';
import { externalPath } from './router.ts';
import type { FeedData, RefreshStatus } from './state.ts';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers = new Headers();
  let requestBody: BodyInit | undefined;
  if (body instanceof FormData) {
    requestBody = body;
  } else if (body !== undefined) {
    headers.set('content-type', 'application/json');
    requestBody = JSON.stringify(body);
  }

  const response = await fetch(externalPath(path), { method, headers, body: requestBody });
  const contentType = response.headers.get('content-type') ?? '';
  const data: unknown = contentType.includes('json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof data === 'object' && data && 'error' in data
      ? String((data as { error: unknown }).error)
      : String(data || response.statusText);
    throw new Error(message);
  }
  return data as T;
}

export const api = {
  config: () => request<Config>('GET', '/api/config'),
  saveConfig: (config: Pick<Config, 'maxBulkOpen' | 'retention'>) => request<Config>('PUT', '/api/config', config),
  entries: () => request<EnrichedEntry[]>('GET', '/api/entries'),
  feeds: () => request<FeedData>('GET', '/api/feeds'),
  startRefresh: () => request<RefreshStatus>('POST', '/api/refresh'),
  refreshStatus: (cursor: number) => request<RefreshStatus>('GET', `/api/refresh/status?since=${cursor}`),
  updateEntries: (entries: Record<string, { read?: boolean; starred?: boolean }>) =>
    request<{ ok: boolean }>('POST', '/api/state', { entries }),
  addFeed: (url: string) => request('POST', '/api/feeds', { url: url.trim() }),
  deleteFeed: (id: string) => request<{ ok: boolean }>('DELETE', `/api/feeds/${encodeURIComponent(id)}`),
  importFeeds: (body: FormData) => request<{ added: number; skipped: number }>('POST', '/api/feeds/import', body),
};
