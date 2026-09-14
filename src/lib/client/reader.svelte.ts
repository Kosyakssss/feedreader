import { getContext } from 'svelte';
import { base } from '$app/paths';
import {
  DEFAULT_CONFIG,
  type Config,
  type EnrichedEntry,
  type EntryState,
  type FeedData,
  type InitialData,
  type RefreshStatus,
  type SharedEventPayload,
  type Theme,
} from '../types';
import { api } from './api';
import { mergeEntryState, safeHttpUrl } from './entries';

type Updates = Record<string, Pick<EntryState, 'read' | 'starred'>>;
type Packet = { id: number; data: SharedEventPayload };
export const readerKey = Symbol('reader');
export const useReader = () => getContext<Reader>(readerKey);
export class Reader {
  entries = $state.raw<EnrichedEntry[]>([]);
  feeds = $state.raw<FeedData>({ feeds: [], health: {} });
  config = $state<Config>(structuredClone(DEFAULT_CONFIG));
  themes = $state.raw<Theme[]>([]);
  complete = $state(false);
  syncing = $state(false);
  status = $state<RefreshStatus | null>(null);
  newIds = $state.raw(new Set<string>());
  toasts = $state<{ id: number; message: string }[]>([]);
  private initialCounts: InitialData['counts'];
  private totals = $derived.by(() => {
    const result = new Map<
      string,
      { total: number; unread: number; starred: number; starredUnread: number }
    >();
    for (const entry of this.entries) {
      const count = result.get(entry.feedId) ?? { total: 0, unread: 0, starred: 0, starredUnread: 0 };
      count.total++;
      if (!entry.state.read) count.unread++;
      if (entry.state.starred) {
        count.starred++;
        if (!entry.state.read) count.starredUnread++;
      }
      result.set(entry.feedId, count);
    }
    return result;
  });
  private saved = new Map<string, EntryState>();
  private pending: Updates[] = [];
  private writes: Promise<unknown> = Promise.resolve();
  private source: EventSource | null = null;
  private controller: AbortController | null = null;
  private incoming: Packet[] = [];
  private needsSync = false;
  private sequence = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private resumeTimer: ReturnType<typeof setTimeout> | undefined;
  private toastTimers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;
  private showRefreshError = false;
  constructor(initial: InitialData) {
    this.initialCounts = initial.counts;
    this.config = initial.config;
    this.themes = initial.themes;
    this.feeds = initial.feeds;
    this.status = initial.status;
    this.receive(initial.entries, true);
  }
  path(path: string): string {
    return base + path;
  }
  counts(feedId?: string, starred = false): { total: number; unread: number } {
    const rows = this.complete
      ? feedId
        ? [this.totals.get(feedId)]
        : [...this.totals.values()]
      : this.initialCounts.filter((row) => !feedId || row.feedId === feedId);
    return rows.reduce(
      (sum, row) => ({
        total: sum.total + (row ? (starred ? row.starred : row.total) : 0),
        unread: sum.unread + (row ? (starred ? row.starredUnread : row.unread) : 0),
      }),
      { total: 0, unread: 0 },
    );
  }
  start(): void {
    if (this.disposed) return;
    this.connect();
    void this.refresh();
  }
  stop(): void {
    this.disposed = true;
    this.controller?.abort();
    this.source?.close();
    clearTimeout(this.flushTimer);
    clearTimeout(this.resumeTimer);
    for (const timer of this.toastTimers) clearTimeout(timer);
  }
  resume(): void {
    if (this.disposed || document.visibilityState === 'hidden') return;
    clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.controller?.abort();
      this.controller = null;
      this.syncing = false;
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      this.incoming = [];
      this.connect();
    }, 50);
  }
  private connect(): void {
    this.source?.close();
    const source = new EventSource(base + '/api/events');
    this.source = source;
    source.onmessage = (event) => {
      if (this.source !== source || this.disposed) return;
      let data: SharedEventPayload;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!Array.isArray(data.topics)) return;
      if (data.topics.length) this.needsSync = true;
      else this.incoming.push({ id: Number(event.lastEventId), data });
      if (this.incoming.length > 256) {
        this.incoming = [];
        this.needsSync = true;
      }
      this.schedule();
    };
  }
  private schedule(delay = 16): void {
    if (this.disposed || this.flushTimer || this.controller) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, delay);
  }
  private async flush(): Promise<void> {
    if (this.needsSync) {
      this.needsSync = false;
      const controller = new AbortController();
      this.controller = controller;
      this.syncing = true;
      try {
        const snapshot = await api.sync(AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
        if (controller.signal.aborted || this.disposed) return;
        this.receive(snapshot.entries, true);
        this.feeds = snapshot.feeds;
        this.config = snapshot.config;
        this.themes = snapshot.themes;
        this.status = snapshot.status;
        this.complete = true;
        this.sequence = snapshot.eventId;
      } catch {
        if (!controller.signal.aborted) this.needsSync = true;
      } finally {
        if (this.controller === controller) {
          this.controller = null;
          this.syncing = false;
        }
      }
      if (controller.signal.aborted || this.disposed) return;
      if (this.needsSync) {
        this.schedule(3000);
        return;
      }
    }
    const packets = this.incoming.splice(0).filter((packet) => packet.id > this.sequence);
    if (!packets.length) return;
    const current = packets.some(({ data }) => data.entries?.length || data.removedIds?.length)
      ? new Map(this.entries.map((entry) => [entry.id, entry]))
      : null;
    const newIds = new Set<string>();
    const health = { ...this.feeds.health };
    let changed = false,
      healthChanged = false;
    for (const { id, data } of packets) {
      this.sequence = id;
      for (const entry of data.entries ?? []) {
        if (!current!.has(entry.id)) newIds.add(entry.id);
        current!.set(entry.id, entry);
        this.saved.set(entry.id, mergeEntryState(this.saved.get(entry.id), entry.state));
        changed = true;
      }
      for (const removed of data.removedIds ?? []) {
        current!.delete(removed);
        this.saved.delete(removed);
        newIds.delete(removed);
        changed = true;
      }
      for (const [entryId, state] of Object.entries(data.entryStates ?? {})) {
        this.saved.set(entryId, mergeEntryState(this.saved.get(entryId), state));
        changed = true;
      }
      for (const result of data.feedResults ?? []) {
        if (!this.feeds.feeds.some((feed) => feed.id === result.feedId)) continue;
        health[result.feedId] = {
          lastFetched: result.completedAt,
          error: result.error,
        };
        healthChanged = true;
      }
      if (data.refresh) {
        this.status = data.refresh;
        if (!data.refresh.refreshing && this.showRefreshError) {
          if (data.refresh.error) this.toast(`Refresh failed: ${data.refresh.error}`);
          this.showRefreshError = false;
        }
      }
    }
    if (healthChanged) this.feeds = { ...this.feeds, health };
    if (changed) {
      this.newIds = newIds;
      if (current)
        this.entries = [...current.values()].sort(
          (a, b) => b.publishedTime - a.publishedTime || a.id.localeCompare(b.id),
        );
      this.project();
    }
  }
  receive(incoming: readonly EnrichedEntry[], replace = false): void {
    for (const entry of incoming)
      this.saved.set(entry.id, mergeEntryState(this.saved.get(entry.id), entry.state));
    if (replace) {
      this.entries = [...incoming];
      this.newIds = new Set();
    } else {
      const current = new Map(this.entries.map((entry) => [entry.id, entry]));
      this.newIds = new Set(incoming.filter((entry) => !current.has(entry.id)).map((entry) => entry.id));
      for (const entry of incoming) current.set(entry.id, entry);
      this.entries = [...current.values()].sort(
        (a, b) => b.publishedTime - a.publishedTime || a.id.localeCompare(b.id),
      );
    }
    this.project();
  }
  private project(): void {
    const optimistic = new Map<string, EntryState>();
    for (const update of this.pending)
      for (const [id, patch] of Object.entries(update))
        optimistic.set(id, { ...optimistic.get(id), ...patch });
    const retained = new Set([...this.entries.map((entry) => entry.id), ...optimistic.keys()]);
    for (const id of this.saved.keys()) if (!retained.has(id)) this.saved.delete(id);
    this.entries = this.entries.map((entry) => {
      const state = { ...(this.saved.get(entry.id) ?? entry.state), ...optimistic.get(entry.id) };
      return state.read === entry.state.read &&
        state.starred === entry.state.starred &&
        state.readAt === entry.state.readAt &&
        state.starredAt === entry.state.starredAt
        ? entry
        : { ...entry, state };
    });
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
  async mark(ids: string[], update: Pick<EntryState, 'read' | 'starred'>): Promise<boolean> {
    if (!ids.length) return true;
    const payload = Object.fromEntries(ids.map((id) => [id, update]));
    this.pending.push(payload);
    this.project();
    const write = this.writes.then(() => api.updateEntries(payload));
    this.writes = write.catch(() => undefined);
    try {
      const result = await write;
      for (const [id, state] of Object.entries(result.entryStates))
        this.saved.set(id, mergeEntryState(this.saved.get(id), state));
      return true;
    } catch (error) {
      this.toast(`Could not save state: ${message(error)}`);
      this.needsSync = true;
      this.schedule();
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
      await this.awaitRefresh();
    } catch (error) {
      if (showError) this.toast(`Refresh failed: ${message(error)}`);
    }
  }
  private async awaitRefresh(): Promise<void> {
    for (let i = 0; i < 80 && !this.disposed; i++) {
      const health = await api.health().catch(() => null);
      const status = health?.lastRefreshResult;
      if (!status) return;
      if (!status.refreshing) {
        this.status = status;
        if (this.showRefreshError) {
          if (status.error) this.toast(`Refresh failed: ${status.error}`);
          this.showRefreshError = false;
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
