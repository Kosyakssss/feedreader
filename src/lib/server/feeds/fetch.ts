import type { Feed, FeedCacheMeta } from '../../types';
import { safeFetchExternal } from '../network';
import { parseFeedAny } from './parse';
import { fetchAtprotoFeed, parseAtprotoFeedUrl } from './atproto';
import { UA, readResponseText, discardResponseBody, type FeedFetchResult } from './transport';
export type { FeedFetchResult, ResolvedFeedInput } from './transport';
const FETCH_CONCURRENCY = 8;
const FEED_FETCH_TIMEOUT_MS = 8000;
const MAX_FEED_BYTES = 10 * 1024 * 1024;
export async function fetchFeed(feed: Feed, meta: FeedCacheMeta = {}): Promise<FeedFetchResult> {
  if (parseAtprotoFeedUrl(feed.url)) return await fetchAtprotoFeed(feed);
  try {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Accept:
        'application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml, text/xml',
    };
    if (meta.etag) headers['If-None-Match'] = meta.etag;
    if (meta.lastModified) headers['If-Modified-Since'] = meta.lastModified;
    const res = await safeFetchExternal(feed.url, {
      headers,
      signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
    });
    const validators = pickValidators(res, res.status === 304 ? meta : {});
    if (res.status === 304) {
      await discardResponseBody(res);
      return { entries: [], notModified: true, validators };
    }
    if (!res.ok) {
      await discardResponseBody(res);
      return { entries: [], error: `HTTP ${res.status}` };
    }
    const body = await readResponseText(res, MAX_FEED_BYTES);
    const parsed = parseFeedAny(body, feed.id);
    if (parsed.format === 'unrecognized') {
      return { entries: [], error: 'Unrecognized feed format', validators };
    }
    return { entries: parsed.entries, validators };
  } catch (e) {
    const msg = (e as Error).message || 'Unknown error';
    return { entries: [], error: msg };
  }
}
function pickValidators(
  res: Response,
  fallback: FeedCacheMeta,
): Pick<FeedCacheMeta, 'etag' | 'lastModified'> {
  return {
    etag: res.headers.get('etag') || fallback.etag,
    lastModified: res.headers.get('last-modified') || fallback.lastModified,
  };
}
export async function fetchAllFeeds(
  feeds: Feed[],
  meta: Record<string, FeedCacheMeta>,
  onFeedResult: (feed: Feed, result: FeedFetchResult, durationMs: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, feeds.length) }, async () => {
      while (next < feeds.length) {
        const feed = feeds[next++]!;
        const started = performance.now();
        const result = await fetchFeed(feed, meta[feed.id]).catch((error) => ({
          entries: [],
          error: error instanceof Error ? error.message : String(error),
        }));
        await onFeedResult(feed, result, performance.now() - started);
      }
    }),
  );
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
