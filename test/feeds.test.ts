import { describe, expect, test } from 'bun:test';
import { fetchAllFeeds, parseFeed, parseOPML } from '../lib/feeds.ts';

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

      if (String(url).includes('bad.example')) {
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
      const feeds = Array.from({ length: 12 }, (_, i) => ({
        id: `feed-${i}`,
        url: i === 10 ? 'https://bad.example/rss' : `https://example.com/${i}.xml`,
        label: `Feed ${i}`,
        folderId: null,
      }));

      const result = await fetchAllFeeds(feeds);

      expect(maxActive).toBeLessThanOrEqual(8);
      expect(result.entries.length).toBe(11);
      expect(result.errors['feed-10']).toBe('HTTP 500');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
