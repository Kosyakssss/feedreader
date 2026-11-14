// Turns the bytes of a feed into a list of items.

export type Item = {
  guid: string;
  url: string;
  title: string;
  text: string;
  published: number | null;
};

type ParsedFeed = {
  title: string;
  items: Item[];
};

const MAX_BODY = 200_000; // a body is only ever read for its text
type Node = Record<string, unknown>;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  para: '¶',
  sect: '§',
  deg: '°',
  cent: '¢',
  pound: '£',
  euro: '€',
  yen: '¥',
};

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
    if (entity[0] !== '#') return ENTITIES[entity.toLowerCase()] ?? match;
    const code = entity[1]!.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

// Turns a body of HTML into one line of text.
export function plain(html: string): string {
  const noHidden = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ');
  return decodeEntities(noHidden.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// A title that says nothing is no title: the row shows the entry's text instead.
export function cleanTitle(title: string, url: string): string {
  const clean = title.replace(/\s+/g, ' ').trim();
  if (['untitled', '(untitled)', 'no title', '(no title)', '[no title]'].includes(clean.toLowerCase())) return '';
  return clean === url ? '' : clean;
}

const isNode = (value: unknown): value is Node => !!value && typeof value === 'object' && !Array.isArray(value);
const asList = <T>(value: T | T[] | undefined): T[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

function rawText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isNode(value) && value['#text'] !== undefined) return rawText(value['#text']);
  return '';
}

const text = (value: unknown) => decodeEntities(rawText(value)).trim();

// Feeds carry bodies as escaped text or as nested XHTML. Nested parts are flattened.
function markup(value: unknown): string {
  const direct = rawText(value).trim();
  if (direct || !isNode(value)) return direct;
  const parts: string[] = [];
  const walk = (part: unknown) => {
    if (typeof part === 'string') parts.push(part);
    else if (Array.isArray(part)) part.forEach(walk);
    else if (isNode(part)) for (const [key, child] of Object.entries(part)) if (key[0] !== '@') walk(child);
  };
  walk(value);
  return parts.join(' ').trim();
}

function link(value: unknown): string {
  if (typeof value === 'string') return text(value);
  const links = asList(value);
  const written = links.map(text).find(Boolean);
  if (written) return written;
  const nodes = links.filter(isNode);
  const chosen = nodes.find((node) => node['@rel'] === 'alternate') ?? nodes.find((node) => !node['@rel']) ?? nodes[0];
  return chosen ? String(chosen['@href'] ?? '').trim() : '';
}

// Date.parse reads RFC 822 too; only a zone name it doesn't know (CEST, IST)
// stops it, and then the time is taken as UTC.
export function parseDate(value: unknown): number | null {
  const raw = rawText(value).trim();
  if (!raw) return null;
  const date = Date.parse(raw);
  const utc = Number.isNaN(date) ? Date.parse(raw.replace(/[a-z]+$/i, 'GMT')) : date;
  return Number.isNaN(utc) ? null : utc;
}

const firstDate = (...values: unknown[]) => values.map(parseDate).find((date) => date !== null) ?? null;

function safeLink(raw: string, base: string): string {
  try {
    const url = new URL(raw.trim(), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function buildItem(
  guid: string,
  rawLink: string,
  title: string,
  body: string,
  published: number | null,
  base: string,
): Item {
  const url = safeLink(rawLink, base);
  return {
    guid: guid || rawLink || title,
    url,
    title: cleanTitle(title, url),
    text: plain(body.slice(0, MAX_BODY)),
    published,
  };
}

function decode(bytes: Uint8Array, contentType: string): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 512));
  const label =
    /<\?xml[^>]*encoding\s*=\s*["']([^"']+)/i.exec(head)?.[1] ??
    /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1] ??
    'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

// Feeds often use HTML entities that XML doesn't define, which stops an XML parser.
function repairEntities(xml: string): string {
  const declared = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);
  for (const match of xml.matchAll(/<!ENTITY\s+([^\s%]+)\s/g)) declared.add(match[1]!);
  return xml.replace(/&([a-z][a-z0-9]*);/gi, (reference, name: string) => {
    if (declared.has(name)) return reference;
    return ENTITIES[name] ?? `&amp;${name};`;
  });
}

function parseXml(xml: string): Node {
  try {
    return Bun.XML.parse(xml) as Node;
  } catch {
    return Bun.XML.parse(repairEntities(xml)) as Node;
  }
}

function rssItem(item: Node, guid: string, base: string): Item {
  const url = link(item.link);
  const body = markup(item['content:encoded']) || markup(item.description);
  return buildItem(guid || url, url, text(item.title), body, firstDate(item.pubDate, item['dc:date']), base);
}

function atomItem(entry: Node, base: string): Item {
  const url = link(entry.link);
  const body = markup(entry.content) || markup(entry.summary);
  return buildItem(
    text(entry.id) || url,
    url,
    text(entry.title),
    body,
    firstDate(entry.published, entry.updated),
    base,
  );
}

function parseJsonFeed(source: string, base: string): ParsedFeed {
  const feed = JSON.parse(source) as Node;
  if (typeof feed.version !== 'string' || !feed.version.startsWith('https://jsonfeed.org/version/'))
    throw new Error('Unrecognized feed format');
  const items = asList(feed.items as Node[]).map((item) => {
    const field = (key: string) => (typeof item[key] === 'string' ? (item[key] as string) : '');
    const url = field('url') || field('external_url');
    const body = field('content_html') || field('content_text') || field('summary');
    return buildItem(
      field('id') || url,
      url,
      field('title'),
      body,
      firstDate(field('date_published'), field('date_modified')),
      base,
    );
  });
  return { title: typeof feed.title === 'string' ? feed.title : '', items };
}

export function parseFeed(bytes: Uint8Array, contentType: string, base: string): ParsedFeed {
  const source = decode(bytes, contentType).replace(/^﻿/, '').trimStart();
  if (source[0] === '{') return parseJsonFeed(source, base);
  const doc = parseXml(source);

  if (isNode(doc.rss)) {
    const channel = (doc.rss.channel ?? {}) as Node;
    return {
      title: text(channel.title),
      items: asList(channel.item as Node[])
        .filter(isNode)
        .map((item) => rssItem(item, text(item.guid), base)),
    };
  }
  if (isNode(doc['rdf:RDF'])) {
    const rdf = doc['rdf:RDF'] as Node;
    return {
      title: text((rdf.channel as Node | undefined)?.title),
      items: asList(rdf.item as Node[])
        .filter(isNode)
        .map((item) => rssItem(item, decodeEntities(String(item['@rdf:about'] ?? '')), base)),
    };
  }
  if (isNode(doc.feed)) {
    const feed = doc.feed;
    return {
      title: text(feed.title),
      items: asList(feed.entry as Node[])
        .filter(isNode)
        .map((entry) => atomItem(entry, base)),
    };
  }
  throw new Error('Unrecognized feed format');
}
