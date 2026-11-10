// OPML, the file feed readers trade their lists of feeds in.
import type { Source } from './store';

export type ListedFeed = { url: string; title: string; folder: string };

type Node = Record<string, unknown>;
const many = (value: unknown): Node[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]) as Node[];
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

// Every feed in the file, once. Folders are flat: a feed goes in the folder
// nearest to it, however deep the file nests them.
export function readOpml(xml: string): ListedFeed[] {
  const document = Bun.XML.parse(xml) as Node;
  const opml = (document.opml ?? {}) as Node;
  const body = (opml.body ?? {}) as Node;
  const found = new Map<string, ListedFeed>();
  const walk = (outlines: Node[], folder: string) => {
    for (const outline of outlines) {
      const url = text(outline['@xmlUrl'] ?? outline['@xmlurl']);
      const name = text(outline['@text']) || text(outline['@title']);
      const category = text(outline['@category']).split('/').filter(Boolean).at(-1) ?? '';
      if (url && !found.has(url)) found.set(url, { url, title: name, folder: folder || category });
      walk(many(outline.outline), url ? folder : name || folder);
    }
  };
  walk(many(body.outline), '');
  return [...found.values()];
}

const attribute = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Bluesky accounts go out as Bluesky's own RSS, so any reader can follow them.
const addressOf = (source: Source) =>
  source.kind === 'atproto' ? `https://bsky.app/profile/${source.ref}/rss` : source.ref;

const line = (source: Source, indent: string) =>
  `${indent}<outline type="rss" text="${attribute(source.label)}" title="${attribute(source.label)}" xmlUrl="${attribute(addressOf(source))}"/>`;

export function writeOpml(sources: Source[]): string {
  const folders = Map.groupBy(sources, (source) => source.folder);
  const body = [...folders].flatMap(([folder, inside]) =>
    folder
      ? [
          `    <outline text="${attribute(folder)}">`,
          ...inside.map((source) => line(source, '      ')),
          '    </outline>',
        ]
      : inside.map((source) => line(source, '    ')),
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    '    <title>Lagan feeds</title>',
    `    <dateCreated>${new Date().toUTCString()}</dateCreated>`,
    '  </head>',
    '  <body>',
    ...body,
    '  </body>',
    '</opml>',
    '',
  ].join('\n');
}

// What a listed feed becomes here. A Bluesky account comes back as itself.
export function sourceFor(feed: ListedFeed): Pick<Source, 'kind' | 'ref' | 'label' | 'folder'> {
  const did = /bsky\.app\/profile\/(did:[^/?#]+)/i.exec(feed.url)?.[1];
  const label = feed.title || new URL(feed.url).hostname;
  return did
    ? { kind: 'atproto', ref: did, label, folder: feed.folder }
    : { kind: 'rss', ref: feed.url, label, folder: feed.folder };
}
