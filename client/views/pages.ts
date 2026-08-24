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
      refresh.disabled = state.initialDataLoading || !!state.refreshStatus?.refreshing;
      refresh.textContent = state.refreshStatus?.refreshing ? 'Refreshing…' : 'Refresh ↻';
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
    const open = button('Open all unread ↗');
    open.dataset.openall = '';
    const mark = button('Mark all read ✓');
    mark.dataset.markall = '';
    const refresh = button(state.refreshStatus?.refreshing ? 'Refreshing…' : 'Refresh ↻');
    refresh.dataset.refresh = '';
    refresh.disabled = state.initialDataLoading || !!state.refreshStatus?.refreshing;
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
  heading.append(element('h1', 'page-title', 'Feeds'), element('div', 'feeds-subtitle', `${state.feeds.feeds.length} sources`));
  header.append(heading);

  const addForm = element('form', 'add-form');
  addForm.id = 'add-feed-form';
  const input = element('input', 'search-input');
  input.name = 'url';
  input.placeholder = 'Feed, site URL, or @handle…';
  input.required = true;
  input.setAttribute('autocomplete', 'url');
  const add = button('Add', 'btn btn-primary');
  add.type = 'submit';
  addForm.append(input, add);

  const fileActions = element('div', 'feed-file-actions');
  const importLabel = element('label', 'btn', 'Import OPML');
  const opml = element('input');
  opml.type = 'file';
  opml.accept = '.opml,.xml';
  opml.id = 'opml-input';
  opml.hidden = true;
  importLabel.append(opml);
  const exportLink = element('a', 'btn', 'Export OPML');
  exportLink.href = externalPath('/api/feeds/export');
  exportLink.setAttribute('download', 'feedreader.opml');
  fileActions.append(importLabel, exportLink);

  const list = element('div', 'feed-list');
  for (const feed of state.feeds.feeds) list.append(buildFeedRow(state, feed));
  if (state.feeds.feeds.length === 0) list.append(element('div', 'empty-state', 'No feeds yet. Add one above!'));
  page.append(header, addForm, fileActions, list);
  return page;
}

function buildFeedRow(state: AppState, feed: Feed): HTMLElement {
  const row = element('div', 'feed-item');
  const info = element('div', 'feed-info');
  const labelRow = element('div', 'feed-label-row');
  const label = element('a', 'feed-label', feed.label);
  label.href = externalPath(`/feed/${encodeURIComponent(feed.id)}`);
  label.dataset.link = '';
  label.dir = 'auto';
  labelRow.append(label);
  info.append(labelRow, element('div', 'feed-meta', feed.url));

  const actions = element('div', 'feed-actions');
  const status = element('div', 'feed-status');
  const unread = state.entries.reduce((count, entry) => count + (entry.feedId === feed.id && !entry.state?.read ? 1 : 0), 0);
  if (unread > 0) status.append(element('span', 'feed-unread-badge', String(unread)));
  const health = state.feeds.health?.[feed.id];
  const lastFetch = health?.lastFetched ? timeAgo(new Date(health.lastFetched).toISOString()) : 'never';
  if (health?.error) {
    const error = element('span', 'feed-error', 'Error');
    error.title = health.error;
    status.append(error);
  } else {
    status.append(element('span', 'feed-ok', `Updated ${lastFetch}${health?.entryCount === 0 && lastFetch !== 'never' ? ' · 0 items' : ''}`));
  }
  const remove = button('✕', 'btn btn-feed-delete');
  remove.dataset.deleteFeed = feed.id;
  remove.dataset.feedLabel = feed.label;
  remove.title = 'Remove feed';
  remove.setAttribute('aria-label', `Remove ${feed.label}`);
  actions.append(status, remove);
  row.append(info, actions);
  return row;
}

function buildSettingsPage(state: AppState): HTMLElement {
  const page = element('div', 'page');
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
