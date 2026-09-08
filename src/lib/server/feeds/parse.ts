import type { Entry } from '../../types';
import { isSafeExternalUrl } from '../security';
const xmlPredefinedEntities = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);
const feedHtmlEntities: Record<string, string> = {
  nbsp: '\u00a0',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  laquo: '\u00ab',
  raquo: '\u00bb',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bull: '\u2022',
  para: '\u00b6',
  sect: '\u00a7',
  deg: '\u00b0',
  frac12: '\u00bd',
  frac14: '\u00bc',
  frac34: '\u00be',
  cent: '\u00a2',
  pound: '\u00a3',
  curren: '\u00a4',
  yen: '\u00a5',
  euro: '\u20ac',
  dollar: '$',
  fnof: '\u0192',
  inr: '\u20b9',
  af: '\u060b',
  birr: '\u1265\u122d',
  peso: '\u20b1',
  rub: '\u20bd',
  won: '\u20a9',
  yuan: '\u00a5',
  cedil: '\u00b8',
};
function parseXml(xml: string): unknown {
  try {
    return Bun.XML.parse(xml);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return Bun.XML.parse(repairXmlEntities(xml));
  }
}
function repairXmlEntities(xml: string): string {
  const declared = new Set<string>(xmlPredefinedEntities);
  for (const match of xml.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<!ENTITY\s+([^\s%]+)\s/g))
    declared.add(match[1]!);
  return xml.replace(
    /&([:_\p{L}\p{Nl}][:_\-.·\p{L}\p{Nl}\p{N}\p{M}\p{Pc}]*);/gu,
    (reference, name: string) => {
      if (declared.has(name)) return reference;
      return Object.hasOwn(feedHtmlEntities, name) ? feedHtmlEntities[name]! : `&amp;${name};`;
    },
  );
}
const namedEntities: Record<string, string> = {
  ...feedHtmlEntities,
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};
export function createEntryId(feedId: string, sourceId: string): string {
  return `${feedId}:${encodeURIComponent(sourceId)}`;
}
export function decodeHtmlEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const raw = hex ? entity.slice(2) : entity.slice(1);
      const codepoint = Number.parseInt(raw, hex ? 16 : 10);
      if (!Number.isFinite(codepoint) || codepoint < 0 || codepoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codepoint);
      } catch {
        return match;
      }
    }
    return Object.hasOwn(namedEntities, entity.toLowerCase()) ? namedEntities[entity.toLowerCase()]! : match;
  });
}
function pickAttribute(value: unknown, decodeAgain = false): string {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  return decodeAgain ? decodeHtmlEntities(text) : text;
}
function pickText(value: unknown): string {
  if (typeof value === 'string') return decodeHtmlEntities(value).trim();
  if (isRecord(value)) {
    if (typeof value['#text'] === 'string') return decodeHtmlEntities(value['#text']).trim();
  }
  if (value === undefined || value === null) return '';
  return decodeHtmlEntities(String(value));
}
function toArray<T>(v: T | T[] | undefined): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}
const monthNumbers: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};
const rfc822ZoneOffsets: Record<string, number> = {
  UT: 0,
  UTC: 0,
  GMT: 0,
  Z: 0,
  EST: -5 * 60,
  EDT: -4 * 60,
  CST: -6 * 60,
  CDT: -5 * 60,
  MST: -7 * 60,
  MDT: -6 * 60,
  PST: -8 * 60,
  PDT: -7 * 60,
};
function parseFeedDate(input: string | number | boolean): string | null {
  const direct = new Date(input as string | number);
  if (!isNaN(direct.getTime())) return direct.toISOString();
  if (typeof input !== 'string') return null;
  const match = input
    .trim()
    .match(
      /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+([A-Za-z]{1,5}|[+-]\d{2}:?\d{2}))?$/i,
    );
  if (!match) return null;
  const [, dayText, monthText, yearText, hourText, minuteText, secondText, zoneText] = match;
  if (!dayText || !monthText || !yearText || !hourText || !minuteText) return null;
  const month = monthNumbers[monthText.toLowerCase()];
  if (month === undefined) return null;
  const day = Number(dayText);
  const rawYear = Number(yearText);
  const year = yearText.length === 2 ? rawYear + (rawYear >= 70 ? 1900 : 2000) : rawYear;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText ? Number(secondText) : 0;
  if (
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31 ||
    !Number.isInteger(year) ||
    !Number.isInteger(hour) ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute > 59 ||
    !Number.isInteger(second) ||
    second > 59
  ) {
    return null;
  }
  const wallClock = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (
    wallClock.getUTCFullYear() !== year ||
    wallClock.getUTCMonth() !== month ||
    wallClock.getUTCDate() !== day
  ) {
    return null;
  }
  const offsetMinutes = parseZoneOffset(zoneText);
  const parsed = new Date(wallClock.getTime() - offsetMinutes * 60 * 1000);
  return parsed.toISOString();
}
function parseZoneOffset(zone: string | undefined): number {
  if (!zone) return 0;
  const numeric = zone.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (numeric) {
    const sign = numeric[1] === '-' ? -1 : 1;
    const hours = Number(numeric[2]);
    const minutes = Number(numeric[3]);
    if (hours > 23 || minutes > 59) return 0;
    return sign * (hours * 60 + minutes);
  }
  const upper = zone.toUpperCase();
  const namedOffset = rfc822ZoneOffsets[upper];
  if (namedOffset !== undefined) return namedOffset;
  return 0;
}
export function pickDate(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (!c) continue;
    const parsed = parseFeedDate(c as string | number | boolean);
    if (parsed) return parsed;
  }
  return new Date().toISOString();
}
export function publishedTime(entry: Pick<Entry, 'published'>): number {
  const time = Date.parse(entry.published);
  return Number.isFinite(time) ? time : 0;
}
function pickLink(link: unknown): string {
  if (typeof link === 'string') return pickText(link);
  if (Array.isArray(link)) {
    const alt = link.find(
      (candidate) => isRecord(candidate) && pickAttribute(candidate['@rel']) === 'alternate',
    );
    const first = alt || link[0];
    return pickAttribute(isRecord(first) ? first['@href'] : first);
  }
  return pickAttribute(isRecord(link) ? link['@href'] : '');
}
function safeEntryUrl(rawUrl: string): string {
  const safe = isSafeExternalUrl(rawUrl);
  return safe.ok ? safe.url.href : '';
}
export function buildEntry(
  feedId: string,
  rawSourceId: string,
  url: string,
  title: string,
  published: string,
): Entry {
  const safeUrl = safeEntryUrl(url);
  const sourceId = rawSourceId || safeUrl || title;
  return {
    id: createEntryId(feedId, sourceId),
    sourceId,
    feedId,
    url: safeUrl,
    title,
    published,
  };
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function decodeFeedBytes(bytes: Buffer, contentType?: string | null): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return decodeWith('utf-8', bytes.subarray(3));
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return decodeWith('utf-16le', bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
    return decodeWith('utf-16be', bytes.subarray(2));
  const charsetFromHeader = /charset=([\w-]+)/i.exec(contentType ?? '')?.[1];
  const declared = /^(<\?xml[^>]*?)\?>/i.exec(bytes.subarray(0, 512).toString('latin1'))?.[1];
  const charsetFromXml = /\bencoding\s*=\s*["']([\w-]+)["']/i.exec(declared ?? '')?.[1];
  for (const label of [charsetFromXml, charsetFromHeader]) {
    if (!label) continue;
    try {
      return decodeWith(label, bytes);
    } catch {}
  }
  return decodeWith('utf-8', bytes);
}
function decodeWith(label: string, bytes: Buffer): string {
  return new TextDecoder(label, { fatal: false }).decode(bytes);
}
type FeedFormat = 'rss' | 'atom' | 'rdf' | 'json' | 'unrecognized';
export interface ParsedFeed {
  format: FeedFormat;
  entries: Entry[];
}
function parseFeedStructured(xml: string, feedId: string): ParsedFeed {
  const entries: Entry[] = [];
  let doc: unknown;
  try {
    doc = parseXml(xml);
  } catch {
    return { format: 'unrecognized', entries };
  }
  if (isRecord(doc) && Object.hasOwn(doc, 'rss')) {
    const rss = isRecord(doc.rss) ? doc.rss : {};
    const channel = isRecord(rss.channel) ? rss.channel : {};
    const rssItems = toArray(channel.item);
    for (const item of rssItems) {
      if (!isRecord(item)) continue;
      const url = pickLink(item.link);
      const title = pickText(item.title) || 'Untitled';
      const published = pickDate(item.pubDate, item['dc:date']);
      entries.push(buildEntry(feedId, pickText(item.guid) || url, url, title, published));
    }
    return { format: 'rss', entries };
  }
  if (isRecord(doc) && Object.hasOwn(doc, 'feed')) {
    const feed = isRecord(doc.feed) ? doc.feed : {};
    const atomEntries = toArray(feed.entry);
    for (const entry of atomEntries) {
      if (!isRecord(entry)) continue;
      const url = pickLink(entry.link);
      const title = pickText(entry.title) || 'Untitled';
      const published = pickDate(entry.published, entry.updated);
      entries.push(buildEntry(feedId, pickText(entry.id || url), url, title, published));
    }
    return { format: 'atom', entries };
  }
  if (isRecord(doc) && Object.hasOwn(doc, 'rdf:RDF')) {
    const rdf = isRecord(doc['rdf:RDF']) ? doc['rdf:RDF'] : {};
    const rdfItems = toArray(rdf.item);
    for (const item of rdfItems) {
      if (!isRecord(item)) continue;
      const url = pickLink(item.link);
      const title = pickText(item.title) || 'Untitled';
      const published = pickDate(item['dc:date'], item.pubDate);
      entries.push(buildEntry(feedId, pickAttribute(item['@rdf:about'], true) || url, url, title, published));
    }
    return { format: 'rdf', entries };
  }
  return { format: 'unrecognized', entries };
}

function tryParseJsonFeed(text: string, feedId: string): ParsedFeed | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const version = typeof record?.version === 'string' ? record.version : undefined;
  if (!version?.startsWith('https://jsonfeed.org/version/') || !Array.isArray(record?.items)) {
    return null;
  }
  const entries: Entry[] = [];
  for (const raw of record.items as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : undefined;
    const url =
      typeof item.url === 'string'
        ? item.url
        : typeof item.external_url === 'string'
          ? item.external_url
          : '';
    const title = typeof item.title === 'string' && item.title ? item.title : 'Untitled';
    const published = pickDate(
      typeof item.date_published === 'string' ? item.date_published : undefined,
      typeof item.date_modified === 'string' ? item.date_modified : undefined,
    );
    entries.push(buildEntry(feedId, id ?? url, url, title, published));
  }
  return { format: 'json', entries };
}
export function parseFeedAny(text: string, feedId: string): ParsedFeed {
  const json = tryParseJsonFeed(text, feedId);
  if (json) return json;
  return parseFeedStructured(text, feedId);
}
export function parseOPML(xml: string): {
  url: string;
  label: string;
}[] {
  const doc = parseXml(xml);
  const feeds: {
    url: string;
    label: string;
  }[] = [];
  function walk(outlines: unknown) {
    for (const o of toArray(outlines)) {
      if (!isRecord(o)) continue;
      if (o['@xmlUrl']) {
        feeds.push({
          url: pickAttribute(o['@xmlUrl']),
          label: pickAttribute(o['@title'] || o['@text'] || o['@xmlUrl'], true),
        });
      }
      if (o.outline) walk(o.outline);
    }
  }
  const opml = isRecord(doc) && isRecord(doc.opml) ? doc.opml : null;
  const body = opml && isRecord(opml.body) ? opml.body : null;
  if (body?.outline) walk(body.outline);
  return feeds;
}
