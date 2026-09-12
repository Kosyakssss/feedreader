import { getContext } from 'svelte';
import {
  DEFAULT_CONFIG,
  type EnrichedEntry,
  type EntryState,
  type SharedEventPayload,
  type SharedTopic,
} from '../types';
import type { FeedData, InitialData } from './types';
import { api } from './api';
import { mergeEntryState, safeHttpUrl } from './values';
import { externalPath } from '../paths';
type Updates = Record<string, Pick<EntryState, 'read' | 'starred'>>;
export const readerKey = Symbol('reader');
export const useReader = () => getContext<Reader>(readerKey);
export class Reader {
  readonly base: string;
  entries = $state.raw<EnrichedEntry[]>([]);
  feeds = $state.raw<FeedData>({ folders: [], feeds: [] });
  config = $state(structuredClone(DEFAULT_CONFIG));
  loading = $state(false);
  complete = $state(false);
  private initialCounts: InitialData['counts'];
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
  private syncController: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private events: EventSource | null = null;
  private disposed = false;
  private toastTimers = new Set<ReturnType<typeof setTimeout>>();
  private incoming: SharedEventPayload[] = [];
  private showRefreshError = false;
  private receiveStatus(status: import('../types').RefreshStatus): void {
    if (status.newEntries.length) this.receive(status.newEntries);
    const removed = new Set(status.removedIds);
    if (removed.size) this.entries = this.entries.filter((entry) => !removed.has(entry.id));
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
    if (!status.refreshing && this.showRefreshError) {
      if (status.error) this.toast(`Refresh failed: ${status.error}`);
      this.showRefreshError = false;
    }
  }
  constructor(initial: InitialData) {
    this.base = initial.base;
    this.receive(initial.entries, true);
    this.feeds = initial.feeds;
    this.config = initial.config;
    this.initialCounts = initial.counts;
    this.status = initial.status;
  }
  path(path: string): string {
    return this.base + path;
  }
  counts(feedId?: string, starred = false): { total: number; unread: number } {
    if (!this.complete)
      return this.initialCounts
        .filter((row) => !feedId || row.feedId === feedId)
        .reduce(
          (sum, row) => ({
            total: sum.total + (starred ? row.starred : row.total),
            unread: sum.unread + (starred ? row.starredUnread : row.unread),
          }),
          { total: 0, unread: 0 },
        );
    const entries = this.entries.filter(
      (entry) => (!feedId || entry.feedId === feedId) && (!starred || entry.state.starred),
    );
    return { total: entries.length, unread: entries.filter((entry) => !entry.state.read).length };
  }
  async start(): Promise<void> {
    if (this.disposed) return;
    this.connect();
    await this.refresh();
  }
  stop(): void {
    this.disposed = true;
    this.syncController?.abort();
    clearTimeout(this.retryTimer);
    this.events?.close();
    for (const timer of this.toastTimers) clearTimeout(timer);
  }
  resume(): void {
    if (!this.disposed && document.visibilityState !== 'hidden') {
      this.syncController?.abort();
      this.syncController = null;
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      this.incoming = [];
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
      this.showRefreshError ||= showError;
      await api.startRefresh(ids);
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
      this.incoming.push(data);
      this.schedule([]);
    };
  }
  private schedule(topics: SharedTopic[]): void {
    topics.forEach((topic) => this.topics.add(topic));
    if (this.syncController || this.retryTimer || this.disposed) return;
    const controller = new AbortController();
    this.syncController = controller;
    void (async () => {
      while ((this.topics.size || this.incoming.length) && !controller.signal.aborted) {
        for (const data of this.incoming.splice(0)) {
          if (data.entryStates) {
            for (const [id, state] of Object.entries(data.entryStates))
              this.saved.set(id, mergeEntryState(this.saved.get(id), state));
            this.project();
          }
          if (data.refresh) this.receiveStatus(data.refresh);
          data.topics
            .filter((topic) => topic !== 'entry-state' && topic !== 'refresh')
            .forEach((topic) => this.topics.add(topic));
        }
        const topics = [...this.topics];
        this.topics.clear();
        if (topics.length) await this.load(topics, controller.signal);
      }
    })()
      .catch(() => {
        if (controller.signal.aborted) return;
        this.topics.add('sync');
        if (document.visibilityState !== 'hidden')
          this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            if (document.visibilityState !== 'hidden') this.schedule([]);
          }, 3000);
      })
      .finally(() => {
        if (this.syncController !== controller) return;
        this.syncController = null;
        if (document.visibilityState !== 'hidden' && (this.topics.size || this.incoming.length))
          this.schedule([]);
      });
  }
  private async load(topics: SharedTopic[], cancellation: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(15000)]);
    const full = topics.includes('sync');
    const [entries, feeds, config, status] = await Promise.all([
      full || topics.includes('entries') ? api.entries(signal) : null,
      full || topics.includes('feeds') ? api.feeds(signal) : null,
      full || topics.includes('config') ? api.config(signal) : null,
      full ? api.refreshStatus(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, signal) : null,
    ]);
    signal.throwIfAborted();
    if (entries) {
      this.receive(entries, true);
      this.complete = true;
    }
    if (feeds) this.feeds = feeds;
    if (config) this.config = config;
    if (status) this.receiveStatus(status);
  }
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
