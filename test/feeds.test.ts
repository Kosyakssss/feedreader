import { describe, expect, test } from 'bun:test';
import { fetchAllFeeds, fetchFeed, parseFeed, parseOPML } from '../lib/feeds.ts';

describe('parseFeed', () => {
  test('parses RSS items', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <guid>post-1</guid>
      <title>Hello RSS</title>
      <link>https://example.com/post-1</link>
      <pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;
    const entries = parseFeed(xml, 'feed-1');
    expect(entries.length).toBe(1);
    expect(entries[0].id).toBe('feed-1:post-1');
    expect(entries[0].sourceId).toBe('post-1');
    expect(entries[0].url).toBe('https://example.com/post-1');
    expect(entries[0].title).toBe('Hello RSS');
    expect(entries[0].feedId).toBe('feed-1');
  });

  test('parses Atom entries with alternate links', () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>atom-1</id>
    <title>Atom post</title>
    <link rel="alternate" href="https://example.com/atom-1" />
    <updated>2025-05-02T12:00:00Z</updated>
  </entry>
</feed>`;
    const entries = parseFeed(xml, 'feed-2');
    expect(entries.length).toBe(1);
    expect(entries[0].id).toBe('feed-2:atom-1');
    expect(entries[0].sourceId).toBe('atom-1');
    expect(entries[0].url).toBe('https://example.com/atom-1');
  });

  test('decodes HTML entities in titles', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <guid>post-2</guid>
      <title>A Visit To ACMI&#039;s Game Worlds &amp; More</title>
      <link>https://example.com/post-2</link>
    </item>
  </channel>
</rss>`;
    const entries = parseFeed(xml, 'feed-3');
    expect(entries.length).toBe(1);
    expect(entries[0].title).toBe("A Visit To ACMI's Game Worlds & More");
  });

  test('scopes entry ids by feed', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <guid>shared-guid</guid>
      <title>Shared</title>
      <link>https://example.com/shared</link>
    </item>
  </channel>
</rss>`;
    const left = parseFeed(xml, 'feed-left')[0];
    const right = parseFeed(xml, 'feed-right')[0];
    expect(left.sourceId).toBe('shared-guid');
    expect(right.sourceId).toBe('shared-guid');
    expect(left.id).not.toBe(right.id);
  });

  test('drops unsafe entry link schemes', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <guid>unsafe-link</guid>
      <title>Unsafe</title>
      <link>javascript:alert(1)</link>
    </item>
  </channel>
</rss>`;
    const entry = parseFeed(xml, 'feed-unsafe')[0];
    expect(entry.url).toBe('');
  });

  test('uses stable ids for entries without guid, link, or date', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Recently</title>
    </item>
  </channel>
</rss>`;
    const first = parseFeed(xml, 'feed-stable')[0];
    const second = parseFeed(xml, 'feed-stable')[0];
    expect(first.sourceId).toBe('Recently');
    expect(second.id).toBe(first.id);
  });
});

describe('parseOPML', () => {
  test('parses nested outline feed urls', () => {
    const xml = `<?xml version="1.0"?>
<opml version="2.0">
  <body>
    <outline text="Folder">
      <outline text="Feed One" xmlUrl="https://one.example/rss" />
      <outline text="Feed Two" xmlUrl="https://two.example/atom.xml" />
    </outline>
  </body>
</opml>`;
    const feeds = parseOPML(xml);
    expect(feeds.length).toBe(2);
    expect(feeds[0].url).toBe('https://one.example/rss');
    expect(feeds[1].url).toBe('https://two.example/atom.xml');
  });

  test('decodes HTML entities in feed labels', () => {
    const xml = `<?xml version="1.0"?>
<opml version="2.0">
  <body>
    <outline text="Dev &amp; Design" xmlUrl="https://example.com/feed.xml" />
  </body>
</opml>`;
    const feeds = parseOPML(xml);
    expect(feeds.length).toBe(1);
    expect(feeds[0].label).toBe('Dev & Design');
  });
});

describe('fetchAllFeeds', () => {
  test('limits concurrent feed fetches and preserves feed errors', async () => {
    const originalFetch = globalThis.fetch;
    let active = 0;
    let maxActive = 0;

    globalThis.fetch = (async (url: string | URL | Request) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5));
      active--;

      if (String(url).includes('/bad.xml')) {
        return new Response('nope', { status: 500 });
      }

      return new Response(`<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <guid>${url}</guid>
      <title>${url}</title>
      <link>${url}</link>
      <pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`, { status: 200 });
    }) as typeof fetch;

    try {
      const feeds = Array.from({ length: 32 }, (_, i) => ({
        id: `feed-${i}`,
        url: i === 30 ? 'https://93.184.216.34/bad.xml' : `https://93.184.216.34/${i}.xml`,
        label: `Feed ${i}`,
        folderId: null,
      }));

      const result = await fetchAllFeeds(feeds);

      expect(maxActive).toBeLessThanOrEqual(24);
      expect(result.entries.length).toBe(31);
      expect(result.errors['feed-30']).toBe('HTTP 500');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('sends conditional GET validators and preserves updated validators', async () => {
    const originalFetch = globalThis.fetch;
    const seenHeaders: Record<string, string> = {};

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenHeaders['if-none-match'] = headers.get('if-none-match') || '';
      seenHeaders['if-modified-since'] = headers.get('if-modified-since') || '';
      return new Response('', {
        status: 304,
        headers: {
          etag: '"next"',
          'last-modified': 'Sat, 16 May 2026 10:00:00 GMT',
        },
      });
    }) as typeof fetch;

    try {
      const result = await fetchAllFeeds([{
        id: 'feed-conditional',
        url: 'https://93.184.216.34/feed.xml',
        label: 'Conditional',
        folderId: null,
      }], {
        'feed-conditional': {
          etag: '"old"',
          lastModified: 'Fri, 15 May 2026 10:00:00 GMT',
        },
      });

      expect(seenHeaders['if-none-match']).toBe('"old"');
      expect(seenHeaders['if-modified-since']).toBe('Fri, 15 May 2026 10:00:00 GMT');
      expect(result.entries).toEqual([]);
      expect(result.errors).toEqual({});
      expect(result.feedMeta['feed-conditional']).toEqual({
        etag: '"next"',
        lastModified: 'Sat, 16 May 2026 10:00:00 GMT',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects redirects to local addresses', async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];

    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response('', {
        status: 302,
        headers: { location: 'http://127.0.0.1/rss.xml' },
      });
    }) as typeof fetch;

    try {
      const result = await fetchFeed({
        id: 'feed-local-redirect',
        url: 'https://93.184.216.34/feed.xml',
        label: 'Redirect',
        folderId: null,
      });

      expect(result.entries).toEqual([]);
      expect(result.error).toContain('Private IPv4 addresses are not allowed');
      expect(calls).toEqual(['https://93.184.216.34/feed.xml']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
