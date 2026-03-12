export interface Feed {
  id: string;
  url: string;
  label: string;
  folderId: string | null;
}

export interface FeedsFile {
  folders: Folder[];
  feeds: Feed[];
}

export interface Folder {
  id: string;
  name: string;
}

export interface Entry {
  id: string;
  feedId: string;
  url: string;
  title: string;
  published: string;
}

export interface EntryState {
  read?: boolean;
  readAt?: number;
  starred?: boolean;
  starredAt?: number;
}

export interface StateFile {
  [entryId: string]: EntryState;
}

export interface Config {
  maxBulkOpen: number;
  retention: {
    maxEntries: number;
    maxDays: number | null;
  };
  defaultOpenAction: 'original' | 'defuddled';
  theme: string | null;
  port: number;
}

export interface CacheFile {
  entries: Entry[];
  lastFetched: Record<string, number>;
  feedErrors: Record<string, string>;
}

export interface EnrichedEntry extends Entry {
  feedLabel: string;
  state: EntryState;
}

export interface ThemeMeta {
  file: string;
  name: string;
  author: string;
  description: string;
}
