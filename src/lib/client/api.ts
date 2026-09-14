import { base } from '$app/paths';
import type {
  Config,
  EnrichedEntry,
  EntryState,
  Feed,
  FeedHealth,
  RefreshStatus,
  Snapshot,
  Theme,
} from '../types';

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const form = body instanceof FormData;
  const response = await fetch(base + path, {
    method,
    signal,
    headers: body !== undefined && !form ? { 'content-type': 'application/json' } : undefined,
    body: form ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.message || response.statusText);
  return data as T;
}
export const api = {
  sync: (signal: AbortSignal) => request<Snapshot>('GET', '/api/sync', undefined, signal),
  health: () => request<{ refreshing: boolean; lastRefreshResult: RefreshStatus }>('GET', '/api/health'),
  saveConfig: (config: Pick<Config, 'maxBulkOpen' | 'retention' | 'theme' | 'appearance'>) =>
    request<Config>('PUT', '/api/config', config),
  themes: () => request<Theme[]>('GET', '/api/themes'),
  startRefresh: (feedIds?: string[]) =>
    request<RefreshStatus>('POST', '/api/refresh', feedIds ? { feedIds } : undefined),
  updateEntries: (entries: Record<string, Pick<EntryState, 'read' | 'starred'>>) =>
    request<{ entryStates: Record<string, EntryState> }>('POST', '/api/state', { entries }),
  addFeed: (url: string) =>
    request<{ feed: Feed; entries: EnrichedEntry[]; removedIds: string[]; health: FeedHealth }>(
      'POST',
      '/api/feeds',
      { url: url.trim() },
    ),
  deleteFeed: (id: string) => request<{ ok: boolean }>('DELETE', `/api/feeds/${encodeURIComponent(id)}`),
  importFeeds: (body: FormData) =>
    request<{ feeds: Feed[]; added: number; skipped: number }>('POST', '/api/feeds/import', body),
};
