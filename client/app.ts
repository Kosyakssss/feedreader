import { EntryStateStore } from './entry-state.ts';
import type { EnrichedEntry } from '../lib/types.ts';
import { api, type FeedreaderApi } from './api.ts';
import { RefreshPoller } from './refresh.ts';
import { animateFeedRemoval } from './motion/feeds.ts';
import { externalPath, internalPath, pushRoute } from './router.ts';
import {
  type AppState,
  type EntryFilter,
  type SharedEventPayload,
  type SharedTopic,
  createInitialState,
  filteredEntries,
  mergeRefreshEntries,
  reconcileTransientState,
  safeHttpUrl,
  visibleEntries,
} from './state.ts';
import { PageView } from './views/pages.ts';
import { ShellView } from './views/shell.ts';

type EntryUpdate = { read?: boolean; starred?: boolean };

export class FeedreaderApp {
  readonly state: AppState;
  readonly shell: ShellView;
  private readonly pages: PageView;
  private readonly refreshPoller: RefreshPoller;
  private readonly client: FeedreaderApi;
  private readonly entryStates = new EntryStateStore();
  private entryWriteChain: Promise<unknown> = Promise.resolve();
  private feedAddAttempt = 0;
  private feedAddRevealTimer: number | null = null;
  private sharedEvents: EventSource | null = null;
  private sharedSyncJob: Promise<void> | null = null;
  private readonly pendingSharedTopics = new Set<SharedTopic>();
  private sharedResumeScheduled = false;

  constructor(root: HTMLElement, client: FeedreaderApi = api) {
    this.state = createInitialState(internalPath(location.pathname));
    this.client = client;
    this.shell = new ShellView();
    this.pages = new PageView(root);
    this.refreshPoller = new RefreshPoller(
      status => this.applyRefreshStatus(status),
      client,
    );
    const resume = () => this.scheduleSharedResume();
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', resume);
    window.addEventListener('online', resume);
  }

  async start(): Promise<void> {
    this.render({ rebuild: true });
    try {
      const [entries, config, feeds] = await Promise.all([
        this.client.entries(),
        this.client.config(),
        this.client.feeds(),
      ]);
      this.receiveEntries(entries, true);
      this.state.config = { ...this.state.config, ...config };
      this.state.feeds = feeds;
      this.state.initialDataLoading = false;
      this.render({ rebuild: this.state.page.startsWith('/feed/') });
    } catch (error) {
      this.state.initialDataLoading = false;
      this.render();
      this.shell.toast(`Could not load saved data: ${errorMessage(error)}`);
      return;
    }

    this.connectSharedEvents();

    try {
      await this.refresh();
    } catch (error) {
      this.setRefreshError(error);
    }
  }

  navigate(path: string, push = true): void {
    this.state.page = path;
    this.state.loadLimit = 50;
    this.state.filter = 'all';
    this.clearSelection();
    this.state.focusedEntryId = null;
    this.state.keyboardNavigationActive = false;
    this.shell.setNavigationOpen(false);
    this.render({ rebuild: true });
    if (push) pushRoute(path);
  }

  setFilter(filter: EntryFilter): void {
    this.state.filter = filter;
    this.state.loadLimit = 50;
    this.clearSelection();
    this.state.focusedEntryId = null;
    this.render();
  }

  showMore(): void {
    this.state.loadLimit += 50;
    this.render();
  }

  async refresh(showFailureToast = false, feedIds?: string[]): Promise<void> {
    try {
      const result = await this.refreshPoller.run(feedIds);
      this.state.feeds = await this.client.feeds();
      this.render();
      if (showFailureToast && result.error) this.shell.toast(`Refresh failed: ${result.error}`);
    } catch (error) {
      this.setRefreshError(error);
      if (showFailureToast) this.shell.toast(`Refresh failed: ${errorMessage(error)}`);
      throw error;
    }
  }

  openEntry(id: string): void {
    const entry = this.entry(id);
    if (!entry) return;
    const url = safeHttpUrl(entry.url);
    if (!url) {
      this.shell.toast('Entry has no safe link');
      return;
    }
    window.open(url, '_blank', 'noopener');
    void this.markEntries([id], { read: true });
  }

  async toggleStar(id: string): Promise<void> {
    const entry = this.entry(id);
    if (entry) await this.markEntries([id], { starred: !entry.state?.starred });
  }

  async toggleRead(id: string): Promise<void> {
    const entry = this.entry(id);
    if (entry) await this.markEntries([id], { read: !entry.state?.read });
  }

  async openAllUnread(): Promise<void> {
    const unread = filteredEntries(this.state).filter(entry => !entry.state?.read);
    if (unread.length === 0) {
      this.shell.toast('No unread entries');
      return;
    }
    const toOpen = unread.slice(0, this.state.config.maxBulkOpen);
    if (unread.length > this.state.config.maxBulkOpen &&
      !confirm(`${unread.length} unread entries. Open first ${this.state.config.maxBulkOpen}?`)) return;
    for (const entry of toOpen) this.openExternal(entry);
    await this.markEntries(toOpen.map(entry => entry.id), { read: true });
  }

  async markAllRead(): Promise<void> {
    const unread = filteredEntries(this.state).filter(entry => !entry.state?.read);
    if (unread.length === 0) return;
    if (await this.markEntries(unread.map(entry => entry.id), { read: true })) {
      this.shell.toast(`${unread.length} marked as read`);
    }
  }

  toggleSelection(id: string, index: number, useRange: boolean): void {
    const visible = visibleEntries(this.state);
    const shouldSelect = !this.state.selectedIds.has(id);
    if (useRange) {
      const anchorIndex = this.state.selectionAnchorId
        ? visible.findIndex(entry => entry.id === this.state.selectionAnchorId)
        : 0;
      if (anchorIndex !== -1 && index !== -1 && visible.length > 0) {
        const [start, end] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
        for (let cursor = start; cursor <= end; cursor++) {
          const entry = visible[cursor];
          if (entry) this.setSelected(entry.id, shouldSelect);
        }
        this.state.selectionAnchorId = id;
        this.render();
        return;
      }
    }
    this.setSelected(id, shouldSelect);
    this.state.selectionAnchorId = id;
    this.render();
  }

  beginDragSelection(id: string, index: number, pointerId: number): void {
    const selecting = !this.state.selectedIds.has(id);
    this.state.selectionDrag = { pointerId, selecting, lastIndex: index };
    this.state.suppressNextSelectClick = true;
    this.setSelected(id, selecting);
    this.state.selectionAnchorId = id;
    document.querySelector('.entry-list')?.classList.add('is-selecting');
    this.render();
  }

  continueDragSelection(index: number): void {
    const drag = this.state.selectionDrag;
    const visible = visibleEntries(this.state);
    if (!drag || index < 0 || index >= visible.length) return;
    const [start, end] = drag.lastIndex < index ? [drag.lastIndex, index] : [index, drag.lastIndex];
    for (let cursor = start; cursor <= end; cursor++) {
      const entry = visible[cursor];
      if (entry) this.setSelected(entry.id, drag.selecting);
    }
    drag.lastIndex = index;
    this.state.selectionAnchorId = visible[index]?.id ?? null;
    this.render();
  }

  endDragSelection(pointerId: number): boolean {
    if (!this.state.selectionDrag || this.state.selectionDrag.pointerId !== pointerId) return false;
    this.state.selectionDrag = null;
    document.querySelector('.entry-list')?.classList.remove('is-selecting');
    window.setTimeout(() => { this.state.suppressNextSelectClick = false; }, 0);
    return true;
  }

  dismissKeyboardNavigation(pointerType: string): void {
    if (!this.state.keyboardNavigationActive || pointerType !== 'mouse') return;
    this.state.keyboardNavigationActive = false;
    this.state.focusedEntryId = null;
    this.render();
  }

  moveFocus(direction: 1 | -1, extendSelection: boolean): void {
    const visible = visibleEntries(this.state);
    if (visible.length === 0) return;
    let index = this.state.focusedEntryId
      ? visible.findIndex(entry => entry.id === this.state.focusedEntryId)
      : -1;
    if (extendSelection && index >= 0) this.state.selectedIds.add(visible[index]!.id);
    index = direction === 1
      ? Math.min(index + 1, visible.length - 1)
      : Math.max(index < 0 ? 0 : index - 1, 0);
    const entry = visible[index];
    if (!entry) return;
    this.state.keyboardNavigationActive = true;
    this.state.focusedEntryId = entry.id;
    if (extendSelection) {
      this.state.selectedIds.add(entry.id);
      this.state.selectionAnchorId = entry.id;
    }
    this.render();
    document.querySelector('.entry-focused')?.scrollIntoView({ block: 'nearest' });
  }

  async focusedAction(action: 'open' | 'read' | 'star' | 'select'): Promise<void> {
    const id = this.state.focusedEntryId;
    if (!id) return;
    if (action === 'open') this.openEntry(id);
    else if (action === 'read') await this.toggleRead(id);
    else if (action === 'star') await this.toggleStar(id);
    else {
      this.setSelected(id, !this.state.selectedIds.has(id));
      this.render();
    }
  }

  escape(): void {
    if (this.shell.shortcutsOpen()) {
      this.shell.setShortcutsOpen(false);
      return;
    }
    if (this.shell.navigationOpen()) {
      this.shell.setNavigationOpen(false);
      return;
    }
    if (this.state.selectedIds.size > 0) {
      this.clearSelection();
      this.render();
      return;
    }
    if (this.state.confirmDeleteFeedId) {
      this.state.confirmDeleteFeedId = null;
      this.render();
      return;
    }
    if (this.state.focusedEntryId) {
      this.state.focusedEntryId = null;
      this.state.keyboardNavigationActive = false;
      this.render();
      return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
  }

  async addFeed(form: HTMLFormElement): Promise<void> {
    const input = form.elements.namedItem('url');
    if (!(input instanceof HTMLInputElement) || this.state.feedAdd.pending) return;
    const value = input.value.trim();
    const attempt = ++this.feedAddAttempt;
    this.state.feedAdd = { pending: true, pendingVisible: false, value, error: null };
    this.render();
    this.feedAddRevealTimer = window.setTimeout(() => {
      if (attempt !== this.feedAddAttempt || !this.state.feedAdd.pending) return;
      this.state.feedAdd.pendingVisible = true;
      this.render();
    }, 120);
    try {
      const result = await this.client.addFeed(value);
      this.state.feeds.feeds = [result.feed, ...this.state.feeds.feeds.filter(feed => feed.id !== result.feed.id)];
      this.state.feeds.health = { ...this.state.feeds.health, [result.feed.id]: result.health };
      this.receiveEntries(result.entries);
      this.state.feedAdd = { pending: false, pendingVisible: false, value: '', error: null };
      this.render({ animateFeeds: true, newFeedIds: new Set([result.feed.id]) });
      this.shell.toast(`Feed added · ${result.entries.length} ${result.entries.length === 1 ? 'entry' : 'entries'} found`);
    } catch (error) {
      this.state.feedAdd = { pending: false, pendingVisible: false, value, error: errorMessage(error) };
      this.render();
    } finally {
      if (attempt === this.feedAddAttempt && this.feedAddRevealTimer !== null) {
        window.clearTimeout(this.feedAddRevealTimer);
        this.feedAddRevealTimer = null;
      }
    }
  }

  setFeedAddValue(value: string): void {
    this.state.feedAdd.value = value;
    if (this.state.feedAdd.error) {
      this.state.feedAdd.error = null;
      this.render();
    }
  }

  async importFeeds(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (!file || this.state.feedImport?.active) return;
    const body = new FormData();
    body.append('file', file);
    this.state.feedImport = {
      total: 0,
      completed: 0,
      succeeded: 0,
      failed: 0,
      active: true,
      feedIds: new Set(),
      completedIds: new Set(),
    };
    this.render();
    try {
      const result = await this.client.importFeeds(body);
      const importedIds = new Set(result.feeds.map(feed => feed.id));
      this.state.feeds.feeds = [
        ...result.feeds,
        ...this.state.feeds.feeds.filter(feed => !importedIds.has(feed.id)),
      ];
      const health = { ...this.state.feeds.health };
      for (const feed of result.feeds) {
        health[feed.id] = { lastFetched: null, error: null, entryCount: 0, checking: true };
      }
      this.state.feeds.health = health;
      this.state.feedImport = result.added > 0 ? {
        total: result.added,
        completed: 0,
        succeeded: 0,
        failed: 0,
        active: true,
        feedIds: importedIds,
        completedIds: new Set(),
      } : null;
      this.render({ animateFeeds: true, newFeedIds: importedIds });
      if (result.added > 0) void this.refresh(false, [...importedIds]).catch(() => undefined);
      else this.shell.toast(`No new feeds · ${result.skipped} skipped`);
    } catch (error) {
      this.state.feedImport = null;
      this.render();
      this.shell.toast(`Error: ${errorMessage(error)}`);
    } finally {
      input.value = '';
    }
  }

  async deleteFeed(id: string, label: string): Promise<void> {
    if (this.state.deletingFeedId) return;
    if (this.state.confirmDeleteFeedId !== id) {
      this.state.confirmDeleteFeedId = id;
      this.render();
      return;
    }
    this.state.deletingFeedId = id;
    this.render();
    try {
      await this.client.deleteFeed(id);
      await animateFeedRemoval(id);
      this.state.feeds.feeds = this.state.feeds.feeds.filter(feed => feed.id !== id);
      if (this.state.feeds.health) delete this.state.feeds.health[id];
      this.state.entries = this.state.entries.filter(entry => entry.feedId !== id);
      this.state.confirmDeleteFeedId = null;
      this.state.deletingFeedId = null;
      reconcileTransientState(this.state);
      this.render();
      this.shell.toast(`${label || 'Feed'} removed`);
    } catch (error) {
      this.state.confirmDeleteFeedId = null;
      this.state.deletingFeedId = null;
      this.render();
      this.shell.toast(`Error: ${errorMessage(error)}`);
    }
  }

  dismissFeedDeleteConfirmation(): void {
    if (!this.state.confirmDeleteFeedId || this.state.deletingFeedId) return;
    this.state.confirmDeleteFeedId = null;
    this.render();
  }

  showMoreFeeds(): void {
    this.state.feedDisplayLimit += 100;
    this.render();
  }

  async saveSettings(form: HTMLFormElement): Promise<void> {
    const values = new FormData(form);
    const updated = {
      maxBulkOpen: parseInteger(values.get('maxBulkOpen'), 20),
      retention: {
        maxEntries: parseInteger(values.get('maxEntries'), 3000),
        maxDays: parseOptionalInteger(values.get('maxDays')),
      },
    };
    try {
      this.state.config = await this.client.saveConfig(updated);
      const theme = document.querySelector<HTMLLinkElement>('#theme-link');
      if (theme) theme.href = `${theme.href.split('?')[0]}?t=${Date.now()}`;
      this.shell.toast('Settings saved');
    } catch (error) {
      this.shell.toast(`Error: ${errorMessage(error)}`);
    }
  }

  async bulk(action: 'read' | 'unread' | 'star' | 'open' | 'cancel'): Promise<void> {
    if (action === 'cancel') {
      this.clearSelection();
      this.render();
      return;
    }
    let selected = this.state.entries.filter(entry => this.state.selectedIds.has(entry.id));
    if (action === 'open') {
      if (selected.length > this.state.config.maxBulkOpen) {
        if (!confirm(`${selected.length} selected. Open first ${this.state.config.maxBulkOpen}?`)) return;
        selected = selected.slice(0, this.state.config.maxBulkOpen);
      }
      for (const entry of selected) this.openExternal(entry);
      await this.markEntries(selected.map(entry => entry.id), { read: true });
    } else {
      await this.markEntries(
        selected.map(entry => entry.id),
        action === 'read' ? { read: true } : action === 'unread' ? { read: false } : { starred: true },
      );
    }
    this.clearSelection();
    this.render();
  }

  private applyRefreshStatus(status: import('./state.ts').RefreshStatus): void {
    const newIds = new Set<string>();
    const removedIds = new Set(status.removedIds ?? []);
    let changed = false;
    if (status.newEntries?.length) {
      for (const id of this.receiveEntries(status.newEntries.filter(entry => !removedIds.has(entry.id)))) newIds.add(id);
      changed = true;
    }
    if (removedIds.size) {
      const before = this.state.entries.length;
      this.state.entries = this.state.entries.filter(entry => !removedIds.has(entry.id));
      changed ||= before !== this.state.entries.length;
    }

    if (status.feedResults?.length) {
      const health = { ...this.state.feeds.health };
      for (const result of status.feedResults) {
        const previous = health[result.feedId] ?? { lastFetched: null, error: null, entryCount: 0 };
        health[result.feedId] = {
          lastFetched: result.completedAt,
          error: result.error,
          entryCount: result.entryCount ?? previous.entryCount,
          checking: false,
        };
        const imported = this.state.feedImport;
        if (imported?.feedIds.has(result.feedId) && !imported.completedIds.has(result.feedId)) {
          imported.completedIds.add(result.feedId);
          imported.completed++;
          if (result.error) imported.failed++;
          else imported.succeeded++;
          imported.active = imported.completed < imported.total;
        }
      }
      this.state.feeds.health = health;
    }

    this.state.refreshStatus = status;
    reconcileTransientState(this.state);
    this.render({
      animate: changed && newIds.size > 0,
      newIds,
    });
  }

  private connectSharedEvents(): void {
    if (this.sharedEvents || typeof EventSource === 'undefined') return;
    const events = new EventSource(externalPath('/api/events'));
    events.onmessage = event => this.receiveSharedEvent(event.data);
    this.sharedEvents = events;
  }

  private scheduleSharedResume(): void {
    if (document.visibilityState === 'hidden' || this.sharedResumeScheduled) return;
    this.sharedResumeScheduled = true;
    queueMicrotask(() => {
      this.sharedResumeScheduled = false;
      this.sharedEvents?.close();
      this.sharedEvents = null;
      this.connectSharedEvents();
      this.queueSharedSync(['sync']);
    });
  }

  private receiveSharedEvent(raw: string): void {
    let payload: SharedEventPayload;
    try {
      payload = JSON.parse(raw) as SharedEventPayload;
    } catch {
      return;
    }
    if (!Array.isArray(payload.topics)) return;

    if (payload.topics.includes('entry-state') && payload.entryStates) {
      this.entryStates.receive(this.state.entries.flatMap(entry => {
        const state = payload.entryStates?.[entry.id];
        return state ? [{ ...entry, state }] : [];
      }));
      this.entryStates.project(this.state.entries);
      this.render();
    }

    const reloadTopics = payload.topics.filter(topic => topic !== 'entry-state');
    if (reloadTopics.length > 0) this.queueSharedSync(reloadTopics);
  }

  private queueSharedSync(topics: readonly SharedTopic[]): void {
    for (const topic of topics) this.pendingSharedTopics.add(topic);
    if (this.sharedSyncJob) return;
    const job = this.drainSharedSync().catch(error => {
      console.warn('Could not synchronize shared UI state:', error);
    }).finally(() => {
      if (this.sharedSyncJob === job) this.sharedSyncJob = null;
      if (this.pendingSharedTopics.size > 0) this.queueSharedSync([]);
    });
    this.sharedSyncJob = job;
  }

  private async drainSharedSync(): Promise<void> {
    while (this.pendingSharedTopics.size > 0) {
      const topics = new Set(this.pendingSharedTopics);
      this.pendingSharedTopics.clear();
      const fullSync = topics.has('sync');
      const reloadEntries = fullSync || topics.has('entries');
      const reloadFeeds = fullSync || topics.has('feeds');
      const reloadConfig = fullSync || topics.has('config');

      const entriesRequest = reloadEntries ? this.client.entries() : null;
      const feedsRequest = reloadFeeds ? this.client.feeds() : null;
      const configRequest = reloadConfig ? this.client.config() : null;
      const [entries, feeds, config] = await Promise.all([
        entriesRequest, feedsRequest, configRequest,
      ]);

      if (entries) {
        this.receiveEntries(entries, true);
        reconcileTransientState(this.state);
      }
      if (feeds) this.state.feeds = feeds;
      if (config) this.state.config = { ...this.state.config, ...config };
      if (entries || feeds || config) this.render({ rebuild: reloadFeeds && this.state.page.startsWith('/feed/') });

      if (fullSync || topics.has('refresh') || topics.has('entries')) {
        await this.refreshPoller.sync(fullSync || topics.has('entries'));
      }
    }
  }

  private setRefreshError(error: unknown): void {
    this.state.refreshStatus = {
      count: 0,
      refreshing: false,
      error: errorMessage(error),
      runId: this.state.refreshStatus?.runId ?? null,
      total: 0,
      completed: 0,
      succeeded: 0,
      failed: 0,
      failures: [],
      cursor: 0,
      feedCursor: 0,
      newEntries: [],
      feedResults: [],
      removedIds: [],
    };
    this.render();
  }

  private receiveEntries(entries: readonly EnrichedEntry[], replace = false): Set<string> {
    this.entryStates.receive(entries);
    const merged = replace ? { entries: [...entries], newIds: new Set<string>() } : mergeRefreshEntries(this.state.entries, entries);
    this.state.entries = merged.entries;
    this.entryStates.project(this.state.entries);
    return merged.newIds;
  }

  private async markEntries(ids: string[], updates: EntryUpdate): Promise<boolean> {
    const selected = new Set(ids);
    const entries = this.state.entries.filter(entry => selected.has(entry.id));
    if (!entries.length) return true;
    const payload = Object.fromEntries(entries.map(entry => [entry.id, updates]));
    this.entryStates.begin(entries, payload);
    this.entryStates.project(this.state.entries);
    this.render();
    const write = this.entryWriteChain.then(() => this.client.updateEntries(payload));
    this.entryWriteChain = write.catch(() => undefined);
    try {
      const result = await write;
      this.entryStates.finish(payload, result.entryStates ?? payload);
      return true;
    } catch (error) {
      this.entryStates.finish(payload);
      this.shell.toast(`Could not save state: ${errorMessage(error)}`);
      try {
        this.receiveEntries(await this.client.entries(), true);
      } catch {}
      return false;
    } finally {
      this.entryStates.project(this.state.entries);
      this.render();
    }
  }

  private openExternal(entry: EnrichedEntry): void {
    const url = safeHttpUrl(entry.url);
    if (url) window.open(url, '_blank', 'noopener');
    else this.shell.toast('Entry has no safe link');
  }

  private entry(id: string): EnrichedEntry | undefined {
    return this.state.entries.find(entry => entry.id === id);
  }

  private setSelected(id: string, selected: boolean): void {
    if (selected) this.state.selectedIds.add(id);
    else this.state.selectedIds.delete(id);
  }

  private clearSelection(): void {
    this.state.selectedIds.clear();
    this.state.selectionAnchorId = null;
  }

  private render(options: import('./views/pages.ts').PageUpdateOptions = {}): void {
    this.pages.update(this.state, options);
    this.shell.update(this.state);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseInteger(value: FormDataEntryValue | null, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOptionalInteger(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
