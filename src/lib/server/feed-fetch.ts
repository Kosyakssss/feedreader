import type { Entry, Feed, FeedCacheMeta } from '../types';
import { safeFetchExternal, discardResponseBody, readResponseBytes, UA } from './external-http';
import { parseFeedAny, type ParsedFeed } from './feed-parser';

export interface FeedFetchResult {
  entries: Entry[];
  error?: string;
  validators?: FeedCacheMeta;
}
export function readFeedResponse(
  response: Response,
  parsed: ParsedFeed,
  fallback: FeedCacheMeta = {},
): FeedFetchResult {
  return {
    entries: parsed.entries,
    ...(parsed.format === 'unrecognized' ? { error: 'Unrecognized feed format' } : {}),
    validators: {
      etag: response.headers.get('etag') || fallback.etag,
      lastModified: response.headers.get('last-modified') || fallback.lastModified,
    },
  };
}
export async function fetchFeed(feed: Feed & FeedCacheMeta): Promise<FeedFetchResult> {
  try {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml',
    };
    if (feed.etag) headers['If-None-Match'] = feed.etag;
    if (feed.lastModified) headers['If-Modified-Since'] = feed.lastModified;
    const response = await safeFetchExternal(feed.url, { headers, signal: AbortSignal.timeout(8000) });
    if (response.status === 304) {
      await discardResponseBody(response);
      return readFeedResponse(response, { format: 'rss', entries: [] }, feed);
    }
    if (!response.ok) {
      await discardResponseBody(response);
      return { entries: [], error: `HTTP ${response.status}` };
    }
    const bytes = await readResponseBytes(response, 10 * 1024 * 1024);
    return readFeedResponse(
      response,
      parseFeedAny(bytes, feed.id, response.headers.get('content-type') ?? ''),
    );
  } catch (error) {
    return { entries: [], error: error instanceof Error ? error.message : String(error) };
  }
}
export async function fetchAllFeeds(
  feeds: (Feed & FeedCacheMeta)[],
  onResult: (feed: Feed, result: FeedFetchResult, durationMs: number) => void,
): Promise<void> {
  let next = 0;
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(8, feeds.length) }, async () => {
      while (next < feeds.length) {
        const feed = feeds[next++]!;
        const started = performance.now();
        onResult(feed, await fetchFeed(feed), performance.now() - started);
      }
    }),
  );
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
