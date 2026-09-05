import type { Entry } from './types.ts';

export class EntryIndex {
  private readonly ids = new Set<string>();
  private readonly sources = new Set<string>();
  private readonly urls = new Set<string>();
  private readonly titles = new Set<string>();
  private readonly legacySources: Set<string>;

  constructor(entries: readonly Entry[]) {
    for (const entry of entries) this.remember(entry);
    this.legacySources = new Set(this.sources);
  }

  add(entry: Entry, feedId: string): boolean {
    const key = (value: string) => `${feedId}\t${value}`;
    const source = entry.sourceId || '';
    const legacy = legacySource(source);
    if (entry.feedId !== feedId || this.ids.has(entry.id) ||
      (source && (this.sources.has(key(source)) || this.legacySources.has(key(legacy)))) ||
      (entry.url ? this.urls.has(key(entry.url)) : entry.title && this.titles.has(key(entry.title)))) return false;
    this.remember(entry);
    return true;
  }

  private remember(entry: Entry): void {
    const key = (value: string) => `${entry.feedId}\t${value}`;
    this.ids.add(entry.id);
    if (entry.sourceId) this.sources.add(key(entry.sourceId));
    if (entry.url) this.urls.add(key(entry.url));
    else if (entry.title) this.titles.add(key(entry.title));
  }
}

function legacySource(source: string): string {
  const hex = /^[-+]?0x[0-9a-f]+$/i.test(source);
  const numeric = hex ? Number.parseInt(source, 16) : Number(source);
  if (!source || !Number.isFinite(numeric)) return source;
  if (hex) return Number.isSafeInteger(numeric) ? String(numeric) : source;
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+$/.test(source) && !/^[+-]?0{2,}[eE]/.test(source)) return String(numeric);
  const normalized = source.replace(/^\+/, '').replace(/^(-?)0+(?=\d)/, '$1')
    .replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').replace(/^(-?)\./, '$10.');
  return normalized === String(numeric) || normalized === '-0' ? String(numeric) : source;
}
