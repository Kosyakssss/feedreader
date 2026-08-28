import type { Feed } from '../../lib/types.ts';
import {
  animateFeedRows,
  animatePendingFeedEnter,
  animatePendingFeedExit,
  cancelFeedSlotMotion,
} from '../motion/feeds.ts';
import { externalPath } from '../router.ts';
import {
  type AppState,
  currentSource,
  entryCounts,
  feedById,
  filteredEntries,
  timeAgo,
} from '../state.ts';
import { button, element } from './dom.ts';
import { EntryListView } from './entry-list.ts';
import { appendTrailingIcon, icon } from './icons.ts';

export interface PageUpdateOptions {
  animate?: boolean;
  newIds?: ReadonlySet<string>;
  animateFeeds?: boolean;
  newFeedIds?: ReadonlySet<string>;
  rebuild?: boolean;
}

interface MountedPage {
  key: string;
  node: HTMLElement;
  entryList: EntryListView | null;
}

export class PageView {
  private mounted: MountedPage | null = null;

  constructor(private readonly root: HTMLElement) {}

  update(state: AppState, options: PageUpdateOptions = {}): void {
    const key = pageKey(state.page);
    if (!this.mounted || this.mounted.key !== key || options.rebuild) {
      this.mounted = this.build(state, key);
      this.root.replaceChildren(this.mounted.node);
    }

    if (key === 'feeds') updateFeedsPage(state, this.mounted.node, options);
    this.updateToolbar(state, this.mounted.node);
    const list = this.mounted.entryList;
    if (list) {
      const filtered = filteredEntries(state);
      list.update(filtered.slice(0, state.loadLimit), {
        loading: state.initialDataLoading,
        selectedIds: state.selectedIds,
        focusedEntryId: state.focusedEntryId,
        totalCount: filtered.length,
        loadLimit: state.loadLimit,
        newIds: options.newIds,
        animate: options.animate,
      });
    }
  }

  private build(state: AppState, key: string): MountedPage {
    if (key === 'feeds') return { key, node: buildFeedsPage(state), entryList: null };
    if (key === 'settings') return { key, node: buildSettingsPage(state), entryList: null };

    const page = element('div', 'page');
    page.dataset.page = key;
    const entryList = new EntryListView();

    if (key === 'starred') {
      page.append(pageHeader('Starred'), entryList.element);
    } else if (key.startsWith('feed:')) {
      const feed = feedById(state.feeds, state.page.slice('/feed/'.length));
      page.append(pageHeader(feed?.label || 'Feed'), buildToolbar(state, true), entryList.element);
    } else {
      page.append(buildToolbar(state, true), entryList.element);
    }
    return { key, node: page, entryList };
  }

  private updateToolbar(state: AppState, root: HTMLElement): void {
    const toolbar = root.querySelector<HTMLElement>('.toolbar');
    if (!toolbar) return;
    const counts = entryCounts(currentSource(state));
    toolbar.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(filter => {
      const name = filter.dataset.filter as keyof typeof counts;
      filter.textContent = `${name[0]?.toUpperCase()}${name.slice(1)} (${counts[name]})`;
      const active = name === state.filter;
      filter.classList.toggle('active', active);
      filter.setAttribute('aria-pressed', String(active));
    });
    toolbar.querySelectorAll<HTMLButtonElement>('[data-refresh]').forEach(refresh => {
      const refreshing = !!state.refreshStatus?.refreshing;
      refresh.disabled = state.initialDataLoading || refreshing;
      refresh.setAttribute('aria-label', refreshing ? 'Refreshing feeds' : 'Refresh feeds');
      if (refreshing) refresh.setAttribute('aria-busy', 'true');
      else refresh.removeAttribute('aria-busy');
    });
  }
}

function pageKey(path: string): string {
  if (path === '/starred') return 'starred';
  if (path === '/feeds') return 'feeds';
  if (path === '/settings') return 'settings';
  if (path.startsWith('/feed/')) return `feed:${path.slice('/feed/'.length)}`;
  return 'timeline';
}

function pageHeader(title: string): HTMLElement {
  const header = element('div', 'page-header');
  header.append(element('h1', 'page-title', title));
  return header;
}

function buildToolbar(state: AppState, showActions: boolean): HTMLElement {
  const toolbar = element('div', 'toolbar');
  const filters = element('div', 'filter-tabs');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Filter entries');
  const counts = entryCounts(currentSource(state));
  for (const name of ['all', 'unread', 'read'] as const) {
    const filter = button(`${name[0]?.toUpperCase()}${name.slice(1)} (${counts[name]})`, name === state.filter ? 'active' : '');
    filter.dataset.filter = name;
    filter.setAttribute('aria-pressed', String(name === state.filter));
    filters.append(filter);
  }
  toolbar.append(filters);

  if (showActions) {
    const actions = element('div', 'timeline-actions');
    const open = button('Open all unread');
    appendTrailingIcon(open, 'external-link');
    open.dataset.openall = '';
    const mark = button('Mark all read');
    appendTrailingIcon(mark, 'check');
    mark.dataset.markall = '';
    const refresh = button('Refresh');
    appendTrailingIcon(refresh, 'refresh');
    refresh.dataset.refresh = '';
    refresh.disabled = state.initialDataLoading || !!state.refreshStatus?.refreshing;
    refresh.setAttribute('aria-label', state.refreshStatus?.refreshing ? 'Refreshing feeds' : 'Refresh feeds');
    if (state.refreshStatus?.refreshing) refresh.setAttribute('aria-busy', 'true');
    actions.append(open, mark, refresh);
    toolbar.append(actions);
  }
  return toolbar;
}

function buildFeedsPage(state: AppState): HTMLElement {
  const page = element('div', 'page feeds-page');
  page.dataset.page = 'feeds';
  const header = element('div', 'page-header feeds-header');
  const heading = element('div');
  heading.append(element('h1', 'page-title', 'Feeds'), element('div', 'feeds-subtitle'));
  header.append(heading);

  const tools = element('div', 'feed-tools');
  const addWrap = element('div', 'add-form-wrap');
  const addForm = element('form', 'add-form');
  addForm.id = 'add-feed-form';
  const inputLabel = element('label', 'visually-hidden', 'Feed or site address');
  inputLabel.htmlFor = 'add-feed-url';
  const input = element('input', 'search-input');
  input.id = 'add-feed-url';
  input.name = 'url';
  input.placeholder = 'Feed, site URL, or @handle…';
  input.required = true;
  input.setAttribute('autocomplete', 'url');
  const add = button('Add', 'btn btn-primary');
  add.type = 'submit';
  addForm.append(input, add);
  const addStatus = element('div', 'add-feed-status');
  addStatus.id = 'add-feed-status';
  addStatus.setAttribute('aria-live', 'polite');
  addStatus.setAttribute('aria-hidden', 'true');
  addStatus.append(element('div', 'add-feed-status-inner'));
  addWrap.append(addForm, addStatus);

  const fileActions = element('div', 'feed-file-actions');
  const importButton = button('Import OPML');
  importButton.dataset.importFeeds = '';
  const opml = element('input');
  opml.type = 'file';
  opml.accept = '.opml,.xml';
  opml.id = 'opml-input';
  opml.hidden = true;
  const exportLink = element('a', 'btn', 'Export OPML');
  exportLink.href = externalPath('/api/feeds/export');
  exportLink.setAttribute('download', 'feedreader.opml');
  fileActions.append(importButton, opml, exportLink);
  tools.append(addWrap, fileActions);

  const importSlot = element('div', 'feed-import-slot');
  importSlot.setAttribute('aria-hidden', 'true');
  const importSlotInner = element('div', 'feed-import-slot-inner');
  const importStatus = element('section', 'feed-import-status');
  importStatus.setAttribute('aria-live', 'polite');
  const importTitle = element('div', 'feed-import-title');
  const importMeter = element('progress', 'feed-import-meter');
  importMeter.hidden = true;
  const importDetail = element('div', 'feed-import-detail');
  importStatus.append(importTitle, importMeter, importDetail);
  importSlotInner.append(importStatus);
  importSlot.append(importSlotInner);

  const list = element('div', 'feed-list');
  list.setAttribute('role', 'list');
  addForm.prepend(inputLabel);
  page.append(header, tools, importSlot, buildFeedListHeader(), list);
  return page;
}

function updateFeedsPage(state: AppState, page: HTMLElement, options: PageUpdateOptions): void {
  const unreadByFeed = new Map<string, number>();
  for (const entry of state.entries) {
    if (!entry.state?.read) unreadByFeed.set(entry.feedId, (unreadByFeed.get(entry.feedId) ?? 0) + 1);
  }
  const unreadTotal = [...unreadByFeed.values()].reduce((sum, count) => sum + count, 0);
  const issueCount = state.feeds.feeds.reduce((count, feed) => count + (state.feeds.health?.[feed.id]?.error ? 1 : 0), 0);
  const summary = [
    `${state.feeds.feeds.length} sources`,
    `${unreadTotal} unread`,
    ...(issueCount > 0 ? [`${issueCount} ${issueCount === 1 ? 'issue' : 'issues'}`] : []),
  ];
  const subtitle = page.querySelector<HTMLElement>('.feeds-subtitle');
  if (subtitle) subtitle.textContent = summary.join(' · ');

  updateAddForm(state, page);
  updateImportStatus(state, page);

  const list = page.querySelector<HTMLElement>('.feed-list');
  if (!list) return;
  list.toggleAttribute('aria-busy', state.feedAdd.pending || !!state.feedImport?.active);
  const header = page.querySelector<HTMLElement>('.feed-list-header');
  if (header) header.hidden = state.feeds.feeds.length === 0;
  list.querySelector('.empty-state')?.remove();
  list.querySelector('.feed-load-more')?.remove();

  let pendingSlot = list.querySelector<HTMLElement>('.feed-pending-slot');
  let createdPending = false;
  if (state.feedAdd.pending) {
    if (!pendingSlot) {
      pendingSlot = element('div', 'feed-slot feed-pending-slot');
      const pending = element('div', 'feed-pending');
      pending.setAttribute('role', 'status');
      pending.append(element('span', 'feed-pending-spinner'), element('div', 'feed-pending-copy'));
      pendingSlot.append(pending);
      list.prepend(pendingSlot);
      createdPending = true;
    } else if (pendingSlot.dataset.exiting === 'true') {
      pendingSlot.removeAttribute('data-exiting');
      cancelFeedSlotMotion(pendingSlot);
    }
    const copy = pendingSlot.querySelector<HTMLElement>('.feed-pending-copy');
    if (copy) copy.replaceChildren(
      element('strong', undefined, 'Finding and checking feed…'),
      element('span', undefined, displayFeedUrl(state.feedAdd.value)),
    );
  } else if (pendingSlot && pendingSlot.dataset.exiting !== 'true') {
    pendingSlot.dataset.exiting = 'true';
    const exitingSlot = pendingSlot;
    void animatePendingFeedExit(exitingSlot).then(completed => {
      if (completed && exitingSlot.dataset.exiting === 'true') exitingSlot.remove();
    });
  }

  const visibleFeeds = state.feeds.feeds.slice(0, state.feedDisplayLimit);
  const visibleIds = new Set(visibleFeeds.map(feed => feed.id));
  const rows = new Map(
    [...list.querySelectorAll<HTMLElement>('.feed-slot[data-feed-id]')]
      .map(row => [row.dataset.feedId ?? '', row] as const),
  );
  for (const [id, row] of rows) {
    if (!visibleIds.has(id)) row.remove();
  }

  const orderedRows: HTMLElement[] = [];
  for (const feed of visibleFeeds) {
    const row = rows.get(feed.id) ?? buildFeedRow(state, feed, unreadByFeed.get(feed.id) ?? 0);
    updateFeedRow(state, row, feed, unreadByFeed.get(feed.id) ?? 0);
    orderedRows.push(row);
  }
  reconcileFeedRowOrder(list, orderedRows, pendingSlot?.isConnected ? pendingSlot : null);

  if (state.feeds.feeds.length === 0 && !state.feedAdd.pending) {
    list.append(element('div', 'empty-state', 'No feeds yet. Add one above!'));
  }
  if (state.feeds.feeds.length > visibleFeeds.length) {
    const more = element('div', 'feed-load-more');
    const buttonNode = button(`Show ${Math.min(100, state.feeds.feeds.length - visibleFeeds.length)} more (${state.feeds.feeds.length - visibleFeeds.length} remaining)`);
    buttonNode.dataset.loadmoreFeeds = '';
    more.append(buttonNode);
    list.append(more);
  }

  if (createdPending && pendingSlot) animatePendingFeedEnter(pendingSlot);
  if (options.animateFeeds && options.newFeedIds?.size) {
    animateFeedRows(orderedRows, options.newFeedIds, pendingSlot ? 45 : 0);
  }
}

function updateAddForm(state: AppState, page: HTMLElement): void {
  const form = page.querySelector<HTMLFormElement>('#add-feed-form');
  const input = page.querySelector<HTMLInputElement>('#add-feed-url');
  const add = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  const status = page.querySelector<HTMLElement>('#add-feed-status');
  if (!form || !input || !add || !status) return;
  form.toggleAttribute('aria-busy', state.feedAdd.pending);
  input.disabled = state.feedAdd.pending;
  add.disabled = state.feedAdd.pending;
  add.textContent = state.feedAdd.pending ? 'Checking…' : 'Add';
  add.classList.toggle('is-busy', state.feedAdd.pending);
  if (!state.feedAdd.pending) input.value = state.feedAdd.value;
  const visible = !!state.feedAdd.error;
  status.classList.toggle('is-visible', visible);
  status.setAttribute('aria-hidden', String(!visible));
  const inner = status.querySelector<HTMLElement>('.add-feed-status-inner');
  if (inner) inner.textContent = visible ? `Couldn’t add feed: ${state.feedAdd.error}` : '';
}

function updateImportStatus(state: AppState, page: HTMLElement): void {
  const slot = page.querySelector<HTMLElement>('.feed-import-slot');
  const panel = slot?.querySelector<HTMLElement>('.feed-import-status');
  const buttonNode = page.querySelector<HTMLButtonElement>('[data-import-feeds]');
  const titleNode = panel?.querySelector<HTMLElement>('.feed-import-title');
  const detailNode = panel?.querySelector<HTMLElement>('.feed-import-detail');
  const meter = panel?.querySelector<HTMLProgressElement>('.feed-import-meter');
  if (!slot || !panel || !buttonNode || !titleNode || !detailNode || !meter) return;
  const progress = state.feedImport;
  buttonNode.disabled = !!progress?.active;
  slot.classList.toggle('is-visible', !!progress);
  slot.setAttribute('aria-hidden', String(!progress));
  if (!progress) {
    titleNode.textContent = '';
    detailNode.textContent = '';
    meter.value = 0;
    meter.hidden = true;
    return;
  }
  if (progress.total === 0) {
    titleNode.textContent = 'Reading subscriptions…';
    detailNode.textContent = '';
    meter.hidden = true;
    return;
  }
  const title = progress.active
    ? `Checking imported feeds · ${progress.completed} / ${progress.total}`
    : `Import complete · ${progress.succeeded} checked${progress.failed ? ` · ${progress.failed} need attention` : ''}`;
  meter.hidden = false;
  meter.max = progress.total;
  meter.value = progress.completed;
  titleNode.textContent = title;
  detailNode.textContent = progress.active
    ? `${progress.succeeded} ready${progress.failed ? ` · ${progress.failed} failed` : ''}`
    : `${progress.total} subscriptions added`;
}

function reconcileFeedRowOrder(list: HTMLElement, rows: readonly HTMLElement[], pending: HTMLElement | null): void {
  let current = pending ? pending.nextElementSibling : list.firstElementChild;
  for (const row of rows) {
    if (current !== row) list.insertBefore(row, current);
    current = row.nextElementSibling;
  }
}

function buildFeedListHeader(): HTMLElement {
  const header = element('div', 'feed-list-header');
  header.setAttribute('aria-hidden', 'true');
  header.append(element('span', undefined, 'Subscription'));
  const metrics = element('div', 'feed-list-header-metrics');
  metrics.append(element('span', undefined, 'Unread'), element('span', undefined, 'Checked'));
  header.append(metrics, element('span'));
  return header;
}

function buildFeedRow(state: AppState, feed: Feed, unread: number): HTMLElement {
  const slot = element('div', 'feed-slot');
  slot.dataset.feedId = feed.id;
  slot.setAttribute('role', 'listitem');
  const row = element('div', 'feed-item');
  const info = element('div', 'feed-info');
  const label = element('a', 'feed-label', feed.label);
  label.href = externalPath(`/feed/${encodeURIComponent(feed.id)}`);
  label.dataset.link = '';
  label.dir = 'auto';
  const meta = element('div', 'feed-meta', displayFeedUrl(feed.url));
  meta.title = feed.url;
  info.append(label, meta);

  const metrics = element('div', 'feed-metrics');
  const unreadMetric = element('span', `feed-unread${unread > 0 ? ' has-unread' : ''}`);
  unreadMetric.setAttribute('aria-label', `${unread} unread ${unread === 1 ? 'entry' : 'entries'}`);
  unreadMetric.append(element('span', 'feed-unread-value', unread > 0 ? String(unread) : '—'), element('span', 'feed-unread-context', ' unread'));
  const health = state.feeds.health?.[feed.id];
  const lastFetch = health?.lastFetched ? timeAgo(new Date(health.lastFetched).toISOString()) : 'never';
  const healthMetric = element('span', `feed-health${health?.error ? ' has-error' : ''}`);
  if (health?.error) {
    healthMetric.textContent = 'Error';
    healthMetric.title = health.error;
  } else {
    if (lastFetch === 'never') healthMetric.textContent = 'Not checked';
    else healthMetric.append(element('span', 'feed-health-prefix', 'Checked '), document.createTextNode(lastFetch));
    if (health?.entryCount === 0 && lastFetch !== 'never') healthMetric.title = 'Feed returned no entries';
  }
  metrics.append(unreadMetric, healthMetric);

  const remove = button('', 'btn btn-feed-delete');
  remove.append(
    icon('close', 'ui-icon feed-delete-icon feed-delete-icon-idle'),
    icon('trash', 'ui-icon feed-delete-icon feed-delete-icon-confirm'),
    element('span', 'feed-delete-spinner'),
  );
  remove.dataset.deleteFeed = feed.id;
  remove.dataset.feedLabel = feed.label;
  remove.title = 'Remove feed';
  remove.setAttribute('aria-label', `Remove ${feed.label}`);
  row.append(info, metrics, remove);
  slot.append(row);
  return slot;
}

function updateFeedRow(state: AppState, slot: HTMLElement, feed: Feed, unread: number): void {
  slot.dataset.feedId = feed.id;
  const row = slot.querySelector<HTMLElement>('.feed-item');
  if (!row) return;
  const label = row.querySelector<HTMLAnchorElement>('.feed-label');
  if (label) {
    label.textContent = feed.label;
    label.href = externalPath(`/feed/${encodeURIComponent(feed.id)}`);
  }
  const meta = row.querySelector<HTMLElement>('.feed-meta');
  if (meta) {
    meta.textContent = displayFeedUrl(feed.url);
    meta.title = feed.url;
  }
  const unreadMetric = row.querySelector<HTMLElement>('.feed-unread');
  if (unreadMetric) {
    unreadMetric.classList.toggle('has-unread', unread > 0);
    unreadMetric.setAttribute('aria-label', `${unread} unread ${unread === 1 ? 'entry' : 'entries'}`);
    const value = unreadMetric.querySelector<HTMLElement>('.feed-unread-value');
    if (value) value.textContent = unread > 0 ? String(unread) : '—';
  }
  const health = state.feeds.health?.[feed.id];
  const healthMetric = row.querySelector<HTMLElement>('.feed-health');
  if (healthMetric) {
    healthMetric.classList.toggle('has-error', !!health?.error);
    healthMetric.classList.toggle('is-checking', !!health?.checking);
    healthMetric.replaceChildren();
    healthMetric.removeAttribute('title');
    if (health?.checking) {
      healthMetric.textContent = 'Checking…';
    } else if (health?.error) {
      healthMetric.textContent = 'Error';
      healthMetric.title = health.error;
    } else {
      const lastFetch = health?.lastFetched ? timeAgo(new Date(health.lastFetched).toISOString()) : 'never';
      if (lastFetch === 'never') healthMetric.textContent = 'Not checked';
      else healthMetric.append(element('span', 'feed-health-prefix', 'Checked '), document.createTextNode(lastFetch));
      if (health?.entryCount === 0 && lastFetch !== 'never') healthMetric.title = 'Feed returned no entries';
    }
  }
  const remove = row.querySelector<HTMLButtonElement>('[data-delete-feed]');
  if (remove) {
    const confirming = state.confirmDeleteFeedId === feed.id;
    const deleting = state.deletingFeedId === feed.id;
    remove.dataset.deleteFeed = feed.id;
    remove.dataset.feedLabel = feed.label;
    remove.classList.toggle('is-confirming', confirming);
    remove.classList.toggle('is-deleting', deleting);
    remove.disabled = deleting;
    remove.toggleAttribute('aria-busy', deleting);
    remove.title = deleting ? 'Removing feed' : confirming ? 'Click again to remove feed' : 'Remove feed';
    remove.setAttribute(
      'aria-label',
      deleting ? `Removing ${feed.label}` : confirming ? `Confirm removal of ${feed.label}` : `Remove ${feed.label}`,
    );
  }
}

function displayFeedUrl(raw: string): string {
  return raw.replace(/^https?:\/\/(?:www\.)?/i, '').replace(/\/$/, '');
}

function buildSettingsPage(state: AppState): HTMLElement {
  const page = element('div', 'page settings-page');
  page.dataset.page = 'settings';
  const form = element('form', 'settings-form');
  form.id = 'settings-form';
  form.append(
    settingsField('Max bulk open tabs', 'maxBulkOpen', state.config.maxBulkOpen, 1),
    settingsField('Max entries to keep', 'maxEntries', state.config.retention.maxEntries, 100),
    settingsField('Max entry age (days, empty = no limit)', 'maxDays', state.config.retention.maxDays ?? '', 1),
  );
  const save = button('Save', 'btn btn-primary');
  save.type = 'submit';
  form.append(save);
  page.append(pageHeader('Settings'), form);
  return page;
}

function settingsField(labelText: string, name: string, value: number | string, min: number): HTMLElement {
  const field = element('div', 'settings-field');
  const label = element('label', undefined, labelText);
  const input = element('input');
  input.name = name;
  input.type = 'number';
  input.min = String(min);
  input.value = String(value);
  label.htmlFor = `setting-${name}`;
  input.id = `setting-${name}`;
  field.append(label, input);
  return field;
}
