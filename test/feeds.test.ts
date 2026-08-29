import { describe, expect, test } from 'bun:test';
import { fetchAllFeeds, fetchFeed, probeFeed, parseAtprotoFeedUrl, parseFeedStructured, parseFeedAny, parseFeed, decodeFeedBytes, parseOPML, resolveFeedInput } from '../lib/feeds.ts';
import type { ExternalFetch } from '../lib/external-fetch.ts';

const directFetch: ExternalFetch = (url, init) => globalThis.fetch(url, { ...init, redirect: 'manual' });

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

  test('preserves trimmed and scalar-normalized entry identity', () => {
    const xml = `<?xml version="1.0"?>
<rss><channel><item>
  <guid>  001  </guid>
  <title>  1.0  </title>
  <link>  https://example.com/scalar  </link>
</item></channel></rss>`;
    const entry = parseFeed(xml, 'feed-compat')[0]!;
    expect(entry.sourceId).toBe('1');
    expect(entry.id).toBe('feed-compat:1');
    expect(entry.title).toBe('1');
    expect(entry.url).toBe('https://example.com/scalar');

    const cases = new Map([
      ['0X10', '0X10'],
      ['+0x10', '16'],
      ['9007199254740993', '9007199254740993'],
      ['123456789012345678', '123456789012345678'],
      ['1e2', '100'],
      ['01e2', '100'],
      ['00e2', '00e2'],
      ['1.2300', '1.23'],
      ['1.0000000000000001', '1.0000000000000001'],
      ['true', 'true'],
    ]);
    for (const [value, expected] of cases) {
      const parsed = parseFeed(`<rss><channel><item><guid>${value}</guid></item></channel></rss>`, 'f')[0]!;
      expect(parsed.sourceId).toBe(expected);
    }
  });

  test('preserves named, unknown, DTD, and CDATA entity behavior', () => {
    const withoutDtd = parseFeed(
      '<rss><channel><item><guid>a</guid><title>A&nbsp;B &mdash; C &bogus;</title></item></channel></rss>',
      'feed-entities',
    )[0]!;
    const externalDtd = parseFeed(
      '<!DOCTYPE rss SYSTEM "https://example.com/rss.dtd"><rss><channel><item><guid>b</guid><title>A&nbsp;B &mdash; C &bogus;</title></item></channel></rss>',
      'feed-entities',
    )[0]!;
    const internalDtd = parseFeed(
      '<!DOCTYPE rss [<!ENTITY custom "Internal value">]><rss><channel><item><guid>c</guid><title>&custom;</title></item></channel></rss>',
      'feed-entities',
    )[0]!;
    const cdata = parseFeed(
      '<rss><channel><item><guid>d</guid><title><![CDATA[A&nbsp;B &mdash; C]]></title></item></channel></rss>',
      'feed-entities',
    )[0]!;

    expect(withoutDtd.title).toBe('A B — C &bogus;');
    expect(externalDtd.title).toBe(withoutDtd.title);
    expect(internalDtd.title).toBe('Internal value');
    expect(cdata.title).toBe('A B &mdash; C');
  });

  test('preserves the full legacy entity map and mixed CDATA text', () => {
    const names = [
      'nbsp', 'copy', 'reg', 'trade', 'mdash', 'ndash', 'hellip', 'laquo', 'raquo', 'lsquo', 'rsquo',
      'ldquo', 'rdquo', 'bull', 'para', 'sect', 'deg', 'frac12', 'frac14', 'frac34', 'cent', 'pound',
      'curren', 'yen', 'euro', 'dollar', 'fnof', 'inr', 'af', 'birr', 'peso', 'rub', 'won', 'yuan', 'cedil',
    ];
    const entry = parseFeed(
      `<rss><channel><item><guid>map</guid><title>${names.map(name => `&${name};`).join('|')}</title></item></channel></rss>`,
      'f',
    )[0]!;
    expect(entry.title).toBe(' |©|®|™|—|–|…|«|»|‘|’|“|”|•|¶|§|°|½|¼|¾|¢|£|¤|¥|€|$|ƒ|₹|؋|ብር|₱|₽|₩|¥|¸');

    const compact = parseFeed('<rss><channel><item><guid>c1</guid><title>A <![CDATA[B]]> C</title></item></channel></rss>', 'f')[0]!;
    const padded = parseFeed('<rss><channel><item><guid>c2</guid><title>A <![CDATA[ B ]]> C</title></item></channel></rss>', 'f')[0]!;
    expect(compact.title).toBe('ABC');
    expect(padded.title).toBe('A B C');
  });

  test('handles DTD comments, parameter entities, and Unicode unknown entities', () => {
    const xml = `<!DOCTYPE rss [
      <!-- ] > <!ENTITY fake "bad"> -->
      <!ENTITY % definitions '<!ENTITY custom "Internal">'>
      %definitions;
    ]><rss><channel><item><guid>entities</guid><title>&custom; &fake; &é; &日本; &foo·bar;</title></item></channel></rss>`;
    expect(parseFeed(xml, 'f')[0]!.title).toBe('Internal &fake; &é; &日本; &foo·bar;');
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

  test('trims OPML attribute values', () => {
    const xml = '<opml><body><outline text="  Feed  " xmlUrl="  https://example.com/feed.xml  "/></body></opml>';
    expect(parseOPML(xml)).toEqual([{ url: 'https://example.com/feed.xml', label: 'Feed' }]);
  });

  test('preserves scalar and single-decoded OPML attributes', () => {
    const xml = '<opml><body><outline text="1.0 &nbsp; &bogus;" xmlUrl="https://example.com/?name=&amp;nbsp;"/></body></opml>';
    expect(parseOPML(xml)).toEqual([{
      url: 'https://example.com/?name=&nbsp;',
      label: '1.0   &bogus;',
    }]);
  });
});

describe('parseFeedStructured', () => {
  const wrap = (body: string) => `<?xml version="1.0"?>\n${body}`;

  test('identifies rss, atom, and rdf formats', () => {
    expect(parseFeedStructured(wrap('<rss version="2.0"><channel><title>t</title></channel></rss>'), 'f').format).toBe('rss');
    expect(parseFeedStructured(wrap('<feed xmlns="http://www.w3.org/2005/Atom"><title>t</title></feed>'), 'f').format).toBe('atom');
    expect(parseFeedStructured(wrap('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF>'), 'f').format).toBe('rdf');
  });

  test('preserves Atom and RDF attribute semantics', () => {
    const atom = parseFeed(
      wrap('<feed><entry><id>atom</id><title>Atom</title><link rel=" alternate " href=" https://example.com/atom "/></entry></feed>'),
      'feed-atom-attrs',
    )[0]!;
    const rdf = parseFeed(
      wrap('<rdf:RDF><item rdf:about="  rdf-id  "><title>RDF</title><link>https://example.com/rdf</link></item></rdf:RDF>'),
      'feed-rdf-attrs',
    )[0]!;
    expect(atom.url).toBe('https://example.com/atom');
    expect(rdf.sourceId).toBe('rdf-id');

    const scalarRdf = parseFeed(
      wrap('<rdf:RDF><item rdf:about="001"><title type="text"> Attribute text </title></item></rdf:RDF>'),
      'feed-rdf-scalar',
    )[0]!;
    expect(scalarRdf.sourceId).toBe('001');
    expect(scalarRdf.title).toBe('Attribute text');
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
    expect(parseFeedStructured(wrap('<feed></feed>'), 'f')).toEqual({ format: 'atom', entries: [] });
    expect(parseFeedStructured(wrap('<rdf:RDF></rdf:RDF>'), 'f')).toEqual({ format: 'rdf', entries: [] });
  });

  test('rejects malformed and excessively nested XML', () => {
    expect(parseFeedStructured('<rss><channel>', 'f').format).toBe('unrecognized');
    const nested = (count: number) => `<rss>${'<x>'.repeat(count)}${'</x>'.repeat(count)}<channel/></rss>`;
    expect(parseFeedStructured(nested(100), 'f').format).toBe('rss');
    expect(parseFeedStructured(nested(101), 'f').format).toBe('unrecognized');
  });

  test('rejects recursive and amplifying internal entities before parsing', () => {
    const declarations = ['<!ENTITY e0 "ha">'];
    for (let level = 1; level <= 18; level++) {
      declarations.push(`<!ENTITY e${level} "&e${level - 1};&e${level - 1};">`);
    }
    const amplified = `<!DOCTYPE rss [${declarations.join('')}]><rss><channel><item><title>&e18;</title></item></channel></rss>`;
    const recursive = '<!DOCTYPE rss [<!ENTITY loop "&loop;">]><rss><channel><item><title>&loop;</title></item></channel></rss>';
    expect(parseFeedStructured(amplified, 'f').format).toBe('unrecognized');
    expect(parseFeedStructured(recursive, 'f').format).toBe('unrecognized');
  });

  test('limits entity expansion rather than rejecting a large bounded document', () => {
    const padding = 'x'.repeat(300 * 1024);
    const xml = `<!DOCTYPE rss [<!ENTITY short "safe">]><rss><channel><item><guid>1</guid><title>&short;</title><description>${padding}</description></item></channel></rss>`;
    const parsed = parseFeedStructured(xml, 'large-bounded');
    expect(parsed.format).toBe('rss');
    expect(parsed.entries[0]?.title).toBe('safe');
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

describe('decodeFeedBytes', () => {
  test('decodes ISO-8859-1 feeds via the XML declaration', () => {
    const xml = '<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><item><title>Café</title></item></channel></rss>';
    const bytes = Buffer.from(xml, 'latin1');
    expect(decodeFeedBytes(bytes)).toContain('Café');
  });

  test('honors charset from Content-Type when the declaration is absent', () => {
    const body = '<title>Café</title>';
    const bytes = Buffer.from(body, 'latin1');
    expect(decodeFeedBytes(bytes, 'application/xml; charset=iso-8859-1')).toBe('<title>Café</title>');
  });

  test('strips a UTF-8 BOM and defaults to UTF-8', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<title>ok</title>', 'utf8')]);
    expect(decodeFeedBytes(bytes)).toBe('<title>ok</title>');
  });

  test('maps windows-1252 punctuation correctly', () => {
    const xml = '<?xml version="1.0" encoding="windows-1252"?><title>\x93quoted\x94 \x91dash\x92</title>';
    expect(decodeFeedBytes(Buffer.from(xml, 'latin1'))).toContain('<title>“quoted” ‘dash’</title>');
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
  test('stops reading a feed response once the byte limit is crossed', async () => {
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 11; index++) controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await fetchFeed({
      id: 'large',
      url: 'https://93.184.216.34/feed.xml',
      label: 'Large',
      folderId: null,
    }, {}, async () => new Response(oversized));
    expect(result.error).toBe('Response body too large');
    expect(cancelled).toBe(true);
  });

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
      expect(result.error).toContain('Non-public IPv4 addresses are not allowed');
      expect(calls).toEqual(['https://93.184.216.34/feed.xml']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('feed input resolution and ATProto feeds', () => {
  test('accepts a scheme-less feed URL and assumes HTTPS', async () => {
    let fetched = false;
    const externalFetch: ExternalFetch = async () => {
      fetched = true;
      return new Response('', { status: 404 });
    };

    await expect(resolveFeedInput('blog.decryption.net.au/feed.xml', externalFetch)).resolves.toEqual({
      url: 'https://blog.decryption.net.au/feed.xml',
      label: 'blog.decryption.net.au',
    });
    expect(fetched).toBe(false);
  });

  test('discovers feeds from scheme-less website addresses over HTTPS', async () => {
    const calls: string[] = [];
    const externalFetch: ExternalFetch = async url => {
      calls.push(String(url));
      return new Response('<link rel="alternate" type="application/rss+xml" href="/feed.xml">', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    };

    await expect(resolveFeedInput('notes.example.com', externalFetch)).resolves.toEqual({
      url: 'https://notes.example.com/feed.xml',
      label: 'notes.example.com',
    });
    expect(calls).toEqual(['https://notes.example.com/']);
  });

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
      await expect(resolveFeedInput('@alice.example', directFetch)).resolves.toEqual({
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
    })) as unknown as typeof fetch;

    try {
      await expect(resolveFeedInput('https://example.com/', directFetch)).rejects.toThrow('No RSS, Atom, JSON Feed');
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
      }, {}, directFetch);

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
