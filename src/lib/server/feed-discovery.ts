import type { Feed } from '../types';
import {
  safeFetchExternal,
  discardResponseBody,
  isSafeExternalUrl,
  readResponseBytes,
  decodeText,
  UA,
  MAX_DISCOVERY_BYTES,
} from './external-http';
import { parseFeedAny } from './feed-parser';
import { fetchFeed, readFeedResponse, type FeedFetchResult } from './feed-fetch';

export async function discoverFeed(
  input: string,
  id: string,
): Promise<{ feed: Feed; result: FeedFetchResult }> {
  const raw = input.trim();
  const safe = isSafeExternalUrl(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  if (!safe.ok) throw new Error(safe.reason);
  const feed = { id, url: safe.url.href, label: safe.url.hostname };
  const response = await safeFetchExternal(feed.url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    await discardResponseBody(response);
    throw new Error(`HTTP ${response.status}`);
  }
  const type = response.headers.get('content-type') ?? '';
  const bytes = await readResponseBytes(
    response,
    type.includes('html') ? MAX_DISCOVERY_BYTES : 10 * 1024 * 1024,
  );
  const parsed = parseFeedAny(bytes, id, type);
  if (parsed.format !== 'unrecognized') return { feed, result: readFeedResponse(response, parsed) };
  const finalUrl = response.url;
  let discovered: string | undefined;
  await new HTMLRewriter()
    .on('link', {
      element(node) {
        if (
          discovered ||
          !/application\/(rss\+xml|atom\+xml|feed\+json)|text\/xml/i.test(node.getAttribute('type') ?? '')
        )
          return;
        const href = node.getAttribute('href');
        if (!href) return;
        try {
          const url = new URL(href, finalUrl);
          if (isSafeExternalUrl(url.href).ok) discovered = url.href;
        } catch {}
      },
    })
    .transform(new Response(decodeText(bytes, type)))
    .text();
  if (discovered) {
    feed.url = discovered;
    feed.label = new URL(discovered).hostname;
    return { feed, result: await fetchFeed(feed) };
  }
  const controller = new AbortController();
  try {
    return await Promise.any(
      ['/feed', '/rss', '/feed.xml', '/atom.xml', '/index.xml', '/rss.xml'].map(async (path) => {
        const url = new URL(path, finalUrl);
        const candidate = { id, url: url.href, label: url.hostname };
        const response = await safeFetchExternal(candidate.url, {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        });
        if (!response.ok) {
          await discardResponseBody(response);
          throw new Error('Not a feed');
        }
        const bytes = await readResponseBytes(response, 10 * 1024 * 1024);
        const parsed = parseFeedAny(bytes, id, response.headers.get('content-type') ?? '');
        if (parsed.format === 'unrecognized') throw new Error('Not a feed');
        return { feed: candidate, result: readFeedResponse(response, parsed) };
      }),
    );
  } catch {
    throw new Error('No RSS, Atom, or JSON Feed found');
  } finally {
    controller.abort();
  }
}
