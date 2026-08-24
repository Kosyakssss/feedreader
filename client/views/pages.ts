import type { EnrichedEntry, Feed } from '../../lib/types.ts';
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
  const unreadByFeed = new Map<string, number>();
  for (const entry of state.entries) {
    if (!entry.state?.read) unreadByFeed.set(entry.feedId, (unreadByFeed.get(entry.feedId) ?? 0) + 1);
  }
  const unreadTotal = [...unreadByFeed.values()].reduce((sum, count) => sum + count, 0);
  const issueCount = state.feeds.feeds.reduce((count, feed) => count + (state.feeds.health?.[feed.id]?.error ? 1 : 0), 0);

  const header = element('div', 'page-header feeds-header');
  const heading = element('div');
  const summary = [
    `${state.feeds.feeds.length} sources`,
    `${unreadTotal} unread`,
    ...(issueCount > 0 ? [`${issueCount} ${issueCount === 1 ? 'issue' : 'issues'}`] : []),
  ];
  heading.append(element('h1', 'page-title', 'Feeds'), element('div', 'feeds-subtitle', summary.join(' · ')));
  header.append(heading);

  const tools = element('div', 'feed-tools');
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
  tools.append(addForm, fileActions);

  const list = element('div', 'feed-list');
  list.setAttribute('role', 'list');
  if (state.feeds.feeds.length > 0) list.append(buildFeedListHeader());
  for (const feed of state.feeds.feeds) list.append(buildFeedRow(state, feed, unreadByFeed.get(feed.id) ?? 0));
  if (state.feeds.feeds.length === 0) list.append(element('div', 'empty-state', 'No feeds yet. Add one above!'));
  addForm.prepend(inputLabel);
  page.append(header, tools, list);
  return page;
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
  const row = element('div', 'feed-item');
  row.setAttribute('role', 'listitem');
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
  remove.append(icon('close'));
  remove.dataset.deleteFeed = feed.id;
  remove.dataset.feedLabel = feed.label;
  remove.title = 'Remove feed';
  remove.setAttribute('aria-label', `Remove ${feed.label}`);
  row.append(info, metrics, remove);
  return row;
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
