import { safeFetchExternal } from '../network';
import type { Entry, FeedCacheMeta } from '../../types';
import { decodeFeedBytes } from './parse';
export const UA = 'Feedreader/1.0';
const FEED_FETCH_TIMEOUT_MS = 8000;
export const MAX_DISCOVERY_BYTES = 2 * 1024 * 1024;
export interface FeedFetchResult {
  entries: Entry[];
  error?: string;
  notModified?: boolean;
  validators?: Pick<FeedCacheMeta, 'etag' | 'lastModified'>;
}
export interface ResolvedFeedInput {
  url: string;
  label: string;
}
export async function fetchJson<T>(rawUrl: string, init: RequestInit = {}): Promise<T> {
  const res = await safeFetchExternal(rawUrl, {
    ...init,
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      ...init.headers,
    },
    signal: init.signal || AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await readResponseText(res, 4096).catch(() => '');
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`);
  }
  return JSON.parse(await readResponseText(res, MAX_DISCOVERY_BYTES)) as T;
}
export async function discardResponseBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {}
}
export async function readResponseText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error('Response body too large');
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('Response body too large');
    }
    chunks.push(value);
  }
  return decodeFeedBytes(Buffer.concat(chunks), res.headers.get('content-type'));
}
