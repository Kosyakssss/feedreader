export type OpenMode = 'original' | 'defuddled';

export interface BulkOpenEntry {
  id: string;
  url: string;
  title: string;
  feedLabel: string;
}

export interface QueueOpenItem {
  id: string;
  title: string;
  feedLabel: string;
  targetUrl: string;
  modeLabel: string;
}

export interface BulkOpenResult {
  blocked: boolean;
  queued: boolean;
  directIds: string[];
  queuedIds: string[];
  handledIds: string[];
}

export interface BulkOpenOptions {
  mode: OpenMode;
  openWindow: (url: string) => boolean;
  openQueuePage: (items: QueueOpenItem[]) => boolean;
}

export function resolveOpenMode(defaultOpenAction: OpenMode, alt: boolean): OpenMode {
  const defuddled = alt ? defaultOpenAction !== 'defuddled' : defaultOpenAction === 'defuddled';
  return defuddled ? 'defuddled' : 'original';
}

export function resolveEntryOpenUrl(url: string, mode: OpenMode): string {
  return mode === 'defuddled' ? '/read?url=' + encodeURIComponent(url) : url;
}

export function buildQueueOpenItems(entries: BulkOpenEntry[], mode: OpenMode): QueueOpenItem[] {
  const modeLabel = mode === 'defuddled' ? 'Defuddled view' : 'Original page';
  return entries.map(entry => ({
    id: entry.id,
    title: entry.title,
    feedLabel: entry.feedLabel,
    targetUrl: resolveEntryOpenUrl(entry.url, mode),
    modeLabel,
  }));
}

export function attemptBulkOpen(entries: BulkOpenEntry[], options: BulkOpenOptions): BulkOpenResult {
  const directIds: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const opened = options.openWindow(resolveEntryOpenUrl(entry.url, options.mode));
    if (opened) {
      directIds.push(entry.id);
      continue;
    }

    const remaining = entries.slice(i);
    const queued = options.openQueuePage(buildQueueOpenItems(remaining, options.mode));
    const queuedIds = queued ? remaining.map(item => item.id) : [];
    return {
      blocked: true,
      queued,
      directIds,
      queuedIds,
      handledIds: directIds.concat(queuedIds),
    };
  }

  return {
    blocked: false,
    queued: false,
    directIds,
    queuedIds: [],
    handledIds: [...directIds],
  };
}
