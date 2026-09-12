import { safeFetchExternal, discardResponseBody } from '../network';
import { isSafeExternalUrl } from '../security';
import { UA, MAX_DISCOVERY_BYTES, readResponseText, type ResolvedFeedInput } from './transport';
import {
  parseAtprotoFeedUrl,
  resolveActorInput,
  resolvePublicationInput,
  resolveDocumentInput,
  extractBlueskyHandle,
} from './atproto';
const DIRECT_FEED_PATH_RE = /\.(xml|rss|atom|json)$/i;
const DIRECT_FEED_ROUTE_RE = /\/(feed|rss|atom|json)\/?$/i;
async function pageLinks(
  html: string,
  pageUrl: string,
): Promise<{
  feed?: string;
  publication?: string;
  document?: string;
}> {
  const links: {
    feed?: string;
    publication?: string;
    document?: string;
  } = {};
  await new HTMLRewriter()
    .on('link', {
      element(node) {
        const href = node.getAttribute('href');
        if (!href) return;
        const rel = node.getAttribute('rel')?.split(/\s+/) ?? [];
        if (rel.includes('site.standard.publication') && href.startsWith('at://')) links.publication ??= href;
        if (rel.includes('site.standard.document') && href.startsWith('at://')) links.document ??= href;
        if (/application\/(rss\+xml|atom\+xml|feed\+json)|text\/xml/i.test(node.getAttribute('type') ?? '')) {
          try {
            const url = new URL(href, pageUrl).href;
            if (isSafeExternalUrl(url).ok) links.feed ??= url;
          } catch {}
        }
      },
    })
    .transform(new Response(html))
    .text();
  return links;
}
async function resolvePageInput(pageUrl: string): Promise<ResolvedFeedInput | null> {
  const res = await safeFetchExternal(pageUrl, {
    headers: { 'User-Agent': UA, Accept: 'text/html, application/xhtml+xml' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    await discardResponseBody(res);
    return null;
  }
  const html = await readResponseText(res, MAX_DISCOVERY_BYTES);
  const links = await pageLinks(html, pageUrl);
  const publicationUri = links.publication;
  if (publicationUri) return await resolvePublicationInput(publicationUri);
  const documentUri = links.document;
  if (documentUri) return await resolveDocumentInput(documentUri);
  const feedUrl = links.feed;
  if (feedUrl) return { url: feedUrl, label: new URL(feedUrl).hostname };
  return null;
}
export async function resolveFeedInput(rawInput: string): Promise<ResolvedFeedInput> {
  const input = rawInput.trim();
  if (parseAtprotoFeedUrl(input)) return { url: input, label: input.replace('atproto://', '') };
  if (!input) throw new Error('Feed URL is required');
  if (input.startsWith('@')) {
    const actor = await resolveActorInput(input);
    if (actor) return actor;
  }
  if (input.startsWith('at://')) {
    const publication = await resolvePublicationInput(input);
    if (publication) return publication;
    const document = await resolveDocumentInput(input);
    if (document) return document;
  }
  const parsedUrl = parseWebInput(input);
  if (parsedUrl) {
    const blueskyHandle = extractBlueskyHandle(parsedUrl);
    if (blueskyHandle) {
      const actor = await resolveActorInput(blueskyHandle);
      if (actor) return actor;
    }
    if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
      const isDirectFeed =
        DIRECT_FEED_PATH_RE.test(parsedUrl.pathname) || DIRECT_FEED_ROUTE_RE.test(parsedUrl.pathname);
      if (isDirectFeed) return { url: parsedUrl.href, label: parsedUrl.hostname };
      const pageInput = await resolvePageInput(parsedUrl.href).catch(() => null);
      if (pageInput) return pageInput;
      const guessedFeed = await discoverCommonFeedUrl(parsedUrl.href);
      if (guessedFeed) return { url: guessedFeed, label: new URL(guessedFeed).hostname };
      const hostnameActor = await resolveActorInput(parsedUrl.hostname).catch(() => null);
      if (hostnameActor) return hostnameActor;
      throw new Error('No RSS, Atom, JSON Feed, Standard Site metadata, or Bluesky handle found');
    }
  }
  const actor = await resolveActorInput(input).catch(() => null);
  if (actor) return actor;
  throw new Error('Enter an RSS/Atom URL, website URL, Bluesky handle, or Standard Site link');
}
function parseWebInput(input: string): URL | null {
  const candidates = [input];
  if (!/^[a-z][a-z\d+.-]*:/i.test(input) && !/\s/.test(input)) candidates.push(`https://${input}`);
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed;
    } catch {}
  }
  return null;
}
async function discoverCommonFeedUrl(pageUrl: string): Promise<string | null> {
  const base = new URL(pageUrl).origin;
  const guesses = ['/feed', '/rss', '/feed.xml', '/atom.xml', '/index.xml', '/rss.xml'];
  const controller = new AbortController();
  try {
    return await Promise.any(
      guesses.map(async (path) => {
        const res = await safeFetchExternal(base + path, {
          method: 'HEAD',
          headers: { 'User-Agent': UA },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        });
        const ct = res.headers.get('content-type') || '';
        if (
          res.ok &&
          (ct.includes('xml') || ct.includes('rss') || ct.includes('atom') || ct.includes('feed+json'))
        ) {
          return base + path;
        }
        throw new Error('Not a feed');
      }),
    );
  } catch {
    return null;
  } finally {
    controller.abort();
  }
}
