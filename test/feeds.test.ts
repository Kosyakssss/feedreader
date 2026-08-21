import { describe, expect, test } from 'vitest';
import { fetchAllFeeds, fetchFeed, probeFeed, parseAtprotoFeedUrl, parseFeedStructured, parseFeedAny, parseFeed, parseOPML, resolveFeedInput } from '../lib/feeds.ts';

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
    expect(entries[0]!.id).toBe('feed-1:post-1');
    expect(entries[0]!.sourceId).toBe('post-1');
    expect(entries[0]!.url).toBe('https://example.com/post-1');
    expect(entries[0]!.title).toBe('Hello RSS');
    expect(entries[0]!.feedId).toBe('feed-1');
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
    expect(entries[0]!.id).toBe('feed-2:atom-1');
    expect(entries[0]!.sourceId).toBe('atom-1');
    expect(entries[0]!.url).toBe('https://example.com/atom-1');
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
    expect(entries[0]!.title).toBe("A Visit To ACMI's Game Worlds & More");
  });

  test('parses RFC-style dates with nonstandard alphabetic timezones', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <guid>summer</guid>
      <title>Summer time</title>
      <link>https://example.com/summer</link>
      <pubDate>Wed, 31 Dec 2025 16:00:05 AEDT</pubDate>
    </item>
    <item>
      <guid>unknown</guid>
      <title>Unknown zone</title>
      <link>https://example.com/unknown</link>
      <pubDate>Wed, 24 Sep 2025 17:09:51 XYZ</pubDate>
    </item>
  </channel>
</rss>`;
    const entries = parseFeed(xml, 'feed-au');
    expect(entries[0]!.published).toBe('2025-12-31T16:00:05.000Z');
    expect(entries[1]!.published).toBe('2025-09-24T17:09:51.000Z');
  });

  test('treats obsolete RFC 822 military zones as UTC', () => {    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <guid>mil-q</guid>
      <title>Quebec</title>
      <link>https://example.com/q</link>
      <pubDate>Wed, 24 Sep 2025 17:09:51 Q</pubDate>
    </item>
    <item>
      <guid>mil-m</guid>
      <title>Mike</title>
      <link>https://example.com/m</link>
      <pubDate>Wed, 24 Sep 2025 17:09:51 M</pubDate>
    </item>
  </channel>
</rss>`;
    const entries = parseFeed(xml, 'feed-mil');
    expect(entries[0]!.published).toBe('2025-09-24T17:09:51.000Z');
    expect(entries[1]!.published).toBe('2025-09-24T17:09:51.000Z');
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
    const left = parseFeed(xml, 'feed-left')[0]!;
    const right = parseFeed(xml, 'feed-right')[0]!;
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
    const entry = parseFeed(xml, 'feed-unsafe')[0]!;
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
    const first = parseFeed(xml, 'feed-stable')[0]!;
    const second = parseFeed(xml, 'feed-stable')[0]!;
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
    expect(feeds[0]!.url).toBe('https://one.example/rss');
    expect(feeds[1]!.url).toBe('https://two.example/atom.xml');
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
    expect(feeds[0]!.label).toBe('Dev & Design');
  });
});

describe('parseFeedStructured', () => {
  const wrap = (body: string) => `<?xml version="1.0"?>\n${body}`;

  test('identifies rss, atom, and rdf formats', () => {
    expect(parseFeedStructured(wrap('<rss version="2.0"><channel><title>t</title></channel></rss>'), 'f').format).toBe('rss');
    expect(parseFeedStructured(wrap('<feed xmlns="http://www.w3.org/2005/Atom"><title>t</title></feed>'), 'f').format).toBe('atom');
    expect(parseFeedStructured(wrap('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF>'), 'f').format).toBe('rdf');
  });

  test('marks non-feed XML as unrecognized even with an XML declaration', () => {
    const parsed = parseFeedStructured('<?xml version="1.0"?><foo><bar>hello</bar></foo>', 'f');
    expect(parsed.format).toBe('unrecognized');
    expect(parsed.entries).toEqual([]);
  });

  test('accepts a recognized root with zero items as an empty feed', () => {
    const parsed = parseFeedStructured(
      wrap('<rss version="2.0"><channel><title>Fine but empty</title></channel></rss>'),
      'f',
    );
    expect(parsed.format).toBe('rss');
    expect(parsed.entries).toEqual([]);
  });

  test('parses JSON Feed 1.1 documents', () => {
    const body = JSON.stringify({
      version: 'https://jsonfeed.org/version/1.1',
      title: 'JSON Feed',
      items: [
        { id: 'jf-1', url: 'https://example.com/jf-1', title: 'First', date_published: '2025-05-02T12:00:00Z' },
        { id: 'jf-2', external_url: 'https://example.com/jf-2', content_text: 'No title here' },
      ],
    });
    const parsed = parseFeedAny(body, 'feed-jf');
    expect(parsed.format).toBe('json');
    expect(parsed.entries[0]).toMatchObject({ sourceId: 'jf-1', url: 'https://example.com/jf-1', title: 'First' });
    expect(parsed.entries[0]!.published).toBe('2025-05-02T12:00:00.000Z');
    expect(parsed.entries[1]!.sourceId).toBe('jf-2');
    expect(parsed.entries[1]!.url).toBe('https://example.com/jf-2');
    expect(parsed.entries[1]!.title).toBe('Untitled');
  });

  test('rejects non-feed JSON as unrecognized', () => {
    expect(parseFeedAny(JSON.stringify({ items: [] }), 'f').format).toBe('unrecognized');
    expect(parseFeedAny(JSON.stringify({ version: 'https://example.com/not-jsonfeed' }), 'f').format).toBe('unrecognized');
    expect(parseFeedAny('{not json', 'f').format).toBe('unrecognized');
  });
});

describe('probeFeed', () => {
  const feedXml = (url: string) => `<?xml version="1.0"?>
<rss version="2.0"><channel><item><guid>g</guid><title>t</title><link>${url}</link></item></channel></rss>`;

  function withFetch(handler: (url: string) => Promise<Response>): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = handler as typeof fetch;
    return () => { globalThis.fetch = original; };
  }

  test('reports ok with entry count for a readable feed', async () => {
    const restore = withFetch(async url => new Response(feedXml(String(url)), { status: 200 }));
    try {
      const probe = await probeFeed('https://93.184.216.34/ok.xml', 'OK');
      expect(probe).toEqual({ ok: true, entryCount: 1 });
    } finally { restore(); }
  });

  test('rejects garbage served at a feed URL', async () => {
    const restore = withFetch(async () => new Response('<?xml version="1.0"?><html><body>nope</body></html>', { status: 200 }));
    try {
      const probe = await probeFeed('https://93.184.216.34/garbage.xml', 'Garbage');
      expect(probe.ok).toBe(false);
      expect(probe.error).toBe('Unrecognized feed format');
    } finally { restore(); }
  });

  test('propagates HTTP failures', async () => {
    const restore = withFetch(async () => new Response('nope', { status: 500 }));
    try {
      const probe = await probeFeed('https://93.184.216.34/broken.xml', 'Broken');
      expect(probe.ok).toBe(false);
      expect(probe.error).toBe('HTTP 500');
    } finally { restore(); }
  });
});

describe('fetchAllFeeds', () => {
  test('fetches every feed concurrently and preserves feed errors', async () => {
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

      expect(maxActive).toBe(Math.min(8, feeds.length));
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
      return new Response(null, {
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

describe('ATProto feeds', () => {
  test('parses internal ATProto feed URLs', () => {
    expect(parseAtprotoFeedUrl('atproto://profile/kote-pdj.bsky.social')).toEqual({
      type: 'profile',
      handle: 'kote-pdj.bsky.social',
    });
    expect(parseAtprotoFeedUrl('atproto://publication/did:plc:abc/3abc')).toEqual({
      type: 'publication',
      did: 'did:plc:abc',
      rkey: '3abc',
    });
    expect(parseAtprotoFeedUrl('https://example.com/rss.xml')).toBeNull();
  });

  test('resolves Bluesky handles to internal profile feeds', async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url: string | URL | Request) => {
      expect(String(url)).toContain('/xrpc/app.bsky.actor.getProfile');
      return new Response(JSON.stringify({
        did: 'did:plc:alice',
        handle: 'alice.example',
        displayName: 'Alice',
      }), { status: 200 });
    }) as typeof fetch;

    try {
      await expect(resolveFeedInput('@alice.example')).resolves.toEqual({
        url: 'atproto://profile/alice.example',
        label: 'Alice',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('resolves plain websites only when feed discovery succeeds', async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url) === 'https://93.184.216.34/') {
        return new Response(
          '<link rel="alternate" type="application/rss+xml" href="/feed.xml">',
          { status: 200, headers: { 'content-type': 'text/html' } },
        );
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;

    try {
      await expect(resolveFeedInput('https://93.184.216.34/')).resolves.toEqual({
        url: 'https://93.184.216.34/feed.xml',
        label: '93.184.216.34',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects plain websites with no feed or ATProto metadata', async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => new Response('<title>No feed here</title>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })) as typeof fetch;

    try {
      await expect(resolveFeedInput('https://example.com/')).rejects.toThrow('No RSS, Atom, JSON Feed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetches Standard Site documents from an ATProto profile feed', async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];

    globalThis.fetch = (async (url: string | URL | Request) => {
      const raw = String(url);
      calls.push(raw);

      if (raw.includes('/xrpc/com.atproto.identity.resolveHandle')) {
        return new Response(JSON.stringify({ did: 'did:plc:alice' }), { status: 200 });
      }

      if (raw.startsWith('https://plc.directory/')) {
        return new Response(JSON.stringify({
          service: [{ id: '#atproto_pds', serviceEndpoint: 'https://93.184.216.34' }],
        }), { status: 200 });
      }

      if (raw.includes('/xrpc/com.atproto.repo.listRecords')) {
        return new Response(JSON.stringify({
          records: [{
            uri: 'at://did:plc:alice/site.standard.document/3doc',
            value: {
              title: 'Hello Standard Site',
              publishedAt: '2026-06-01T10:00:00.000Z',
              path: '/hello',
              site: 'at://did:plc:alice/site.standard.publication/3pub',
            },
          }],
        }), { status: 200 });
      }

      if (raw.includes('/xrpc/com.atproto.repo.getRecord')) {
        return new Response(JSON.stringify({
          uri: 'at://did:plc:alice/site.standard.publication/3pub',
          value: {
            name: 'Alice Notes',
            url: 'https://alice.example',
          },
        }), { status: 200 });
      }

      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    try {
      const result = await fetchFeed({
        id: 'feed-atproto',
        url: 'atproto://profile/alice.example',
        label: 'Alice',
        folderId: null,
      });

      expect(result.error).toBeUndefined();
      expect(result.entries).toEqual([{
        id: 'feed-atproto:at%3A%2F%2Fdid%3Aplc%3Aalice%2Fsite.standard.document%2F3doc',
        sourceId: 'at://did:plc:alice/site.standard.document/3doc',
        feedId: 'feed-atproto',
        url: 'https://alice.example/hello',
        title: 'Hello Standard Site',
        published: '2026-06-01T10:00:00.000Z',
      }]);
      expect(calls.some(call => call.includes('site.standard.document'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
