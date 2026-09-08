import { getContext } from 'svelte';
import {
  DEFAULT_CONFIG,
  type EnrichedEntry,
  type EntryState,
  type SharedEventPayload,
  type SharedTopic,
} from '../types';
import type { FeedData } from './types';
import { api } from './api';
import { RefreshPoller } from './refresh';
import { mergeEntryState, safeHttpUrl } from './values';
import { externalPath } from './paths';
type Updates = Record<string, Pick<EntryState, 'read' | 'starred'>>;
export const readerKey = Symbol('reader');
export const useReader = () => getContext<Reader>(readerKey);
export class Reader {
  entries = $state.raw<EnrichedEntry[]>([]);
  feeds = $state.raw<FeedData>({ folders: [], feeds: [] });
  config = $state(structuredClone(DEFAULT_CONFIG));
  loading = $state(true);
  status = $state<import('../types').RefreshStatus | null>(null);
  newIds = new Set<string>();
  toasts = $state<
    {
      id: number;
      message: string;
    }[]
  >([]);
  private saved = new Map<string, EntryState>();
  private pending: Updates[] = [];
  private writes: Promise<unknown> = Promise.resolve();
  private topics = new Set<SharedTopic>();
  private syncJob: Promise<void> | null = null;
  private events: EventSource | null = null;
  private disposed = false;
  private toastTimers = new Set<ReturnType<typeof setTimeout>>();
  private poller = new RefreshPoller((status) => {
    this.receive(status.newEntries);
    const removed = new Set(status.removedIds);
    this.entries = this.entries.filter((entry) => !removed.has(entry.id));
    const health = { ...this.feeds.health };
    for (const item of status.feedResults)
      health[item.feedId] = {
        lastFetched: item.completedAt,
        error: item.error,
        entryCount: item.entryCount ?? health[item.feedId]?.entryCount ?? 0,
        checking: false,
      };
    this.feeds = { ...this.feeds, health };
    this.status = status;
  });
  async start(): Promise<void> {
    try {
      const [entries, feeds, config] = await Promise.all([api.entries(), api.feeds(), api.config()]);
      this.receive(entries, true);
      this.feeds = feeds;
      this.config = config;
      this.loading = false;
      if (this.disposed) return;
      this.connect();
      await this.refresh();
    } catch (error) {
      this.loading = false;
      this.toast(`Could not load saved data: ${message(error)}`);
    }
  }
  stop(): void {
    this.disposed = true;
    this.events?.close();
    for (const timer of this.toastTimers) clearTimeout(timer);
  }
  resume(): void {
    if (!this.disposed && document.visibilityState !== 'hidden') {
      this.events?.close();
      this.connect();
      this.schedule(['sync']);
    }
  }
  toast(text: string): void {
    const id = Date.now() + Math.random();
    this.toasts.push({ id, message: text });
    const timer = setTimeout(() => {
      this.toasts = this.toasts.filter((toast) => toast.id !== id);
      this.toastTimers.delete(timer);
    }, 2320);
    this.toastTimers.add(timer);
  }
  receive(incoming: readonly EnrichedEntry[], replace = false): void {
    for (const entry of incoming)
      this.saved.set(entry.id, mergeEntryState(this.saved.get(entry.id), entry.state));
    const current = new Map((replace ? [] : this.entries).map((entry) => [entry.id, entry]));
    this.newIds = new Set(
      replace ? [] : incoming.filter((entry) => !current.has(entry.id)).map((entry) => entry.id),
    );
    for (const entry of incoming) current.set(entry.id, entry);
    this.entries = [...current.values()].sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
    this.project();
  }
  private project(): void {
    const retained = new Set([
      ...this.entries.map((entry) => entry.id),
      ...this.pending.flatMap(Object.keys),
    ]);
    for (const id of this.saved.keys()) if (!retained.has(id)) this.saved.delete(id);
    this.entries = this.entries.map((entry) => ({
      ...entry,
      state: Object.assign(
        {},
        this.saved.get(entry.id) ?? entry.state,
        ...this.pending.map((updates) => updates[entry.id]),
      ),
    }));
  }
  async mark(ids: string[], update: Pick<EntryState, 'read' | 'starred'>): Promise<boolean> {
    const payload = Object.fromEntries(ids.map((id) => [id, update]));
    if (!ids.length) return true;
    this.pending.push(payload);
    this.project();
    const write = this.writes.then(() => api.updateEntries(payload));
    this.writes = write.catch(() => undefined);
    try {
      const result = await write;
      for (const [id, state] of Object.entries(result.entryStates ?? {}))
        this.saved.set(id, mergeEntryState(this.saved.get(id), state));
      return true;
    } catch (error) {
      this.toast(`Could not save state: ${message(error)}`);
      this.schedule(['entries']);
      return false;
    } finally {
      this.pending = this.pending.filter((item) => item !== payload);
      this.project();
    }
  }
  toggle(id: string, key: 'read' | 'starred'): void {
    const entry = this.entries.find((entry) => entry.id === id);
    if (entry) void this.mark([id], { [key]: !entry.state[key] });
  }
  open(entry: EnrichedEntry): void {
    const url = safeHttpUrl(entry.url);
    if (!url) {
      this.toast('Entry has no safe link');
      return;
    }
    window.open(url, '_blank', 'noopener');
    void this.mark([entry.id], { read: true });
  }
  async openMany(entries: EnrichedEntry[], kind: 'unread' | 'selected'): Promise<void> {
    if (!entries.length) {
      if (kind === 'unread') this.toast('No unread entries');
      return;
    }
    const limit = this.config.maxBulkOpen;
    if (
      entries.length > limit &&
      !confirm(`${entries.length} ${kind === 'unread' ? 'unread entries' : 'selected'}. Open first ${limit}?`)
    )
      return;
    const chosen = entries.slice(0, limit);
    for (const entry of chosen) {
      const url = safeHttpUrl(entry.url);
      if (url) window.open(url, '_blank', 'noopener');
      else this.toast('Entry has no safe link');
    }
    await this.mark(
      chosen.map((entry) => entry.id),
      { read: true },
    );
  }
  async refresh(showError = false, ids?: string[]): Promise<void> {
    try {
      const status = await this.poller.run(ids);
      this.feeds = await api.feeds();
      if (showError && status.error) this.toast(`Refresh failed: ${status.error}`);
    } catch (error) {
      if (showError) this.toast(`Refresh failed: ${message(error)}`);
    }
  }
  private connect(): void {
    this.events = new EventSource(externalPath('/api/events'));
    this.events.onmessage = (event) => {
      let data: SharedEventPayload;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!Array.isArray(data.topics)) return;
      if (data.entryStates) {
        for (const [id, state] of Object.entries(data.entryStates))
          this.saved.set(id, mergeEntryState(this.saved.get(id), state));
        this.project();
      }
      this.schedule(data.topics.filter((topic) => topic !== 'entry-state'));
    };
  }
  private schedule(topics: SharedTopic[]): void {
    topics.forEach((topic) => this.topics.add(topic));
    if (this.syncJob || this.disposed) return;
    this.syncJob = (async () => {
      while (this.topics.size && !this.disposed) {
        const topics = [...this.topics];
        this.topics.clear();
        await this.load(topics);
      }
    })()
      .catch(() => this.toast('Could not synchronize saved changes'))
      .finally(() => {
        this.syncJob = null;
        if (this.topics.size) this.schedule([]);
      });
  }
  private async load(topics: SharedTopic[]): Promise<void> {
    const full = topics.includes('sync');
    const [entries, feeds, config] = await Promise.all([
      full || topics.includes('entries') ? api.entries() : null,
      full || topics.includes('feeds') ? api.feeds() : null,
      full || topics.includes('config') ? api.config() : null,
    ]);
    if (entries) this.receive(entries, true);
    if (feeds) this.feeds = feeds;
    if (config) this.config = config;
    if (full || topics.includes('refresh') || topics.includes('entries'))
      await this.poller.sync(full || topics.includes('entries'));
  }
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
