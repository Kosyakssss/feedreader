import type { Config } from './types.ts';

function safeJsonForScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

export function renderApp(config: Config, basePath = ''): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔖</text></svg>">
<title>Feedreader</title>
<meta name="description" content="A personal feed reader">
<meta name="application-name" content="Feedreader">
<meta property="og:title" content="Feedreader">
<meta property="og:site_name" content="Feedreader">
<link rel="stylesheet" href="${basePath}/api/theme" id="theme-link">
<style>
@layer structural {
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  [hidden] { display: none !important; }
  body { min-height: 100dvh; }
  .nav-bar {
    position: sticky; top: 0; z-index: 50;
    display: flex; align-items: center; justify-content: space-between;
    padding: var(--spacing-sm) var(--spacing-md);
    gap: var(--spacing-md);
  }
  .nav-links { display: flex; gap: var(--spacing-xs); }
  .refresh-status { margin-left: auto; white-space: nowrap; }
  .nav-menu-button { display: none; }
  .nav-scrim { position: fixed; inset: 0; z-index: 40; }
  .page { max-width: 720px; margin: 0 auto; padding: var(--spacing-md); }
  .search-input { display: block; width: 100%; margin-bottom: var(--spacing-sm); }
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-sm); margin-bottom: var(--spacing-sm); row-gap: var(--spacing-xs); }
  .filter-tabs { display: flex; gap: var(--spacing-xs); }
  .timeline-actions { display: flex; gap: var(--spacing-xs); margin-left: auto; }
  .entry-list { display: flex; flex-direction: column; }
  .entry-card {
    display: flex; align-items: center; gap: var(--spacing-sm);
    cursor: default;
  }
  .entry-leading-space { width: 2px; flex-shrink: 0; display: none; }
  .entry-checkbox { display: flex; align-items: center; flex-shrink: 0; }
  .entry-content { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .entry-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .entry-actions { display: flex; gap: var(--spacing-xs); flex-shrink: 0; }
  .bulk-bar {
    position: fixed; bottom: 0; left: 0; right: 0; z-index: 50;
    display: flex; align-items: center; justify-content: center;
    gap: var(--spacing-sm); padding: var(--spacing-sm) var(--spacing-md);
  }
  .shortcuts-overlay {
    position: fixed; inset: 0; z-index: 100;
    display: flex; align-items: center; justify-content: center;
  }
  .shortcuts-grid {
    display: grid; grid-template-columns: auto 1fr;
    gap: var(--spacing-xs) var(--spacing-md);
    align-items: center;
    margin-bottom: var(--spacing-md);
  }
  .feed-list { display: flex; flex-direction: column; }
  .feed-item { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-sm); }
  .feed-info { flex: 1; min-width: 0; }
  .feed-actions { display: flex; gap: var(--spacing-xs); align-items: center; }
  .add-form { display: flex; gap: var(--spacing-sm); margin-bottom: var(--spacing-md); }
  .add-form input { flex: 1; }
  .settings-form { display: flex; flex-direction: column; gap: var(--spacing-md); max-width: 400px; }
  .settings-field { display: flex; flex-direction: column; gap: var(--spacing-xs); }
  .toast-container { position: fixed; bottom: var(--spacing-lg); right: var(--spacing-lg); z-index: 60; }
  .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--spacing-md); }
  .load-more { display: flex; justify-content: center; padding: var(--spacing-md); }
  .empty-state { text-align: center; padding: var(--spacing-xl); color: var(--text-muted); }
}
</style>
</head>
<body>
<nav class="nav-bar">
  <a href="${basePath}/" class="nav-logo" data-link>🔖 Feedreader</a>
  <span class="refresh-status" id="refresh-status" role="status" aria-live="polite"></span>
  <button class="nav-menu-button" type="button" aria-label="Open navigation" aria-expanded="false" data-nav-menu>☰</button>
  <div class="nav-links">
    <a href="${basePath}/" data-link class="nav-link" data-nav="/">Timeline</a>
    <a href="${basePath}/starred" data-link class="nav-link" data-nav="/starred">Starred</a>
    <a href="${basePath}/feeds" data-link class="nav-link" data-nav="/feeds">Feeds</a>
    <a href="${basePath}/settings" data-link class="nav-link" data-nav="/settings">Settings</a>
  </div>
</nav>
<div class="nav-scrim" data-nav-scrim hidden></div>
<main id="app"></main>
<div id="bulk-bar" class="bulk-bar" hidden>
  <span class="bulk-count" id="bulk-count"></span>
  <button class="btn" id="bulk-read">Mark read</button>
  <button class="btn" id="bulk-unread">Mark unread</button>
  <button class="btn" id="bulk-open">Open ↗</button>
  <button class="btn" id="bulk-star">★ Star</button>
  <button class="btn" id="bulk-cancel">Cancel</button>
</div>
<div id="shortcuts-overlay" class="shortcuts-overlay" hidden>
  <div class="shortcuts-panel">
    <h2>Keyboard Shortcuts</h2>
    <div class="shortcuts-grid">
      <kbd>j</kbd><span>Next entry</span>
      <kbd>k</kbd><span>Previous entry</span>
      <kbd>o</kbd><span>Open entry</span>
      <kbd>m</kbd><span>Toggle read</span>
      <kbd>s</kbd><span>Toggle star</span>
      <kbd>x</kbd><span>Toggle select</span>
      <kbd>a</kbd><span>Mark all read</span>
      <kbd>r</kbd><span>Refresh feeds</span>
      <kbd>/</kbd><span>Search</span>
      <kbd>?</kbd><span>Show shortcuts</span>
      <kbd>Esc</kbd><span>Close / clear</span>
    </div>
    <button class="btn" onclick="document.getElementById('shortcuts-overlay').hidden=true">Close</button>
  </div>
</div>
<div class="toast-container" id="toast-container"></div>

<script>
const CONFIG = ${safeJsonForScript(config)};
const BASE_PATH = ${safeJsonForScript(basePath)};
let entries = [];
let feeds = { folders: [], feeds: [] };
let selectedIds = new Set();
let focusedIndex = -1;
let searchQuery = '';
let currentFilter = 'all';
let currentPage = '';
let loadLimit = 50;
let selectionAnchorId = null;
let selectionDrag = null;
let suppressNextSelectClick = false;
let keyboardNavigationActive = false;
let initialDataLoading = true;
let refreshStatus = null;
let refreshRunId = null;
let refreshCursor = 0;

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function timeAgo(iso) {
  const d = new Date(iso);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 172800) return 'yesterday';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function externalPath(path) {
  if (!BASE_PATH) return path;
  if (path === '/') return BASE_PATH + '/';
  return BASE_PATH + path;
}

function internalPath(path) {
  if (!BASE_PATH) return path;
  if (path === BASE_PATH) return '/';
  if (path.startsWith(BASE_PATH + '/')) return path.slice(BASE_PATH.length) || '/';
  return path;
}

function apiPath(path) {
  return externalPath(path);
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) { opts.body = body; }
  else if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(apiPath(path), opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || data || res.statusText);
  return data;
}

async function refreshData() {
  return pollRefresh(await api('POST', '/api/refresh'));
}

async function pollRefresh(initial) {
  let latest = initial;
  applyRefreshStatus(latest);
  while (latest?.refreshing) {
    await new Promise(r => setTimeout(r, 750));
    latest = await api('GET', '/api/refresh/status?since=' + refreshCursor);
    applyRefreshStatus(latest);
  }
  feeds = await api('GET', '/api/feeds');
  if (currentPage === '/feeds') renderCurrentPage();
  return latest;
}

function applyRefreshStatus(status) {
  if (!status) return;
  if (status.runId && status.runId !== refreshRunId) {
    refreshRunId = status.runId;
    refreshCursor = 0;
  }

  let entriesChanged = false;
  const removedIds = new Set(Array.isArray(status.removedIds) ? status.removedIds : []);
  if (removedIds.size > 0) {
    const before = entries.length;
    entries = entries.filter(entry => !removedIds.has(entry.id));
    entriesChanged = entries.length !== before;
  }

  if (Array.isArray(status.newEntries) && status.newEntries.length > 0) {
    const indexes = new Map(entries.map((entry, index) => [entry.id, index]));
    for (const entry of status.newEntries) {
      const index = indexes.get(entry.id);
      if (index === undefined) {
        indexes.set(entry.id, entries.length);
        entries.push(entry);
      } else {
        entries[index] = entry;
      }
      entriesChanged = true;
    }
    entries.sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  }

  refreshCursor = Math.max(refreshCursor, Number(status.cursor) || 0);
  refreshStatus = status;
  if (entriesChanged) renderCurrentPage();
  else updateRefreshIndicator();
}

function refreshStatusText() {
  if (initialDataLoading) return 'Loading saved entries…';
  if (!refreshStatus) return '';
  if (refreshStatus.refreshing) {
    if (!refreshStatus.total && !refreshStatus.completed) return 'Starting refresh…';
    const progress = refreshStatus.total > 0
      ? refreshStatus.completed + '/' + refreshStatus.total
      : String(refreshStatus.completed || 0);
    return 'Checking feeds ' + progress + (refreshStatus.count ? ' · ' + refreshStatus.count + ' new' : '');
  }
  if (refreshStatus.error) return 'Refresh failed';
  const result = refreshStatus.count ? refreshStatus.count + ' new' : 'Up to date';
  const failures = Array.isArray(refreshStatus.failures) ? refreshStatus.failures : [];
  return failures.length
    ? result + ' · ' + failures.length + ' failed: ' + failures.map(failure => failure.label).join(', ')
    : result;
}

function updateRefreshIndicator() {
  const status = document.getElementById('refresh-status');
  if (status) {
    status.textContent = refreshStatusText();
    const failures = Array.isArray(refreshStatus?.failures) ? refreshStatus.failures : [];
    status.title = failures.map(failure => failure.label + ': ' + failure.error).join('\\n');
  }
  const button = document.querySelector('[data-refresh]');
  if (button) {
    const refreshing = !!refreshStatus?.refreshing;
    button.disabled = initialDataLoading || refreshing;
    button.textContent = refreshing ? 'Refreshing…' : 'Refresh ↻';
  }
}

function getFiltered(source) {
  let list = source || entries;
  if (currentFilter === 'unread') list = list.filter(e => !e.state?.read);
  if (currentFilter === 'read') list = list.filter(e => e.state?.read);
  if (searchQuery) {
    const tokens = searchQuery.toLowerCase().trim().split(/\\s+/).filter(Boolean);
    if (tokens.length > 0) {
      list = list.filter(e => {
        const hay = (e.title + ' ' + e.feedLabel + ' ' + e.url).toLowerCase();
        return tokens.every(t => hay.includes(t));
      });
    }
  }
  return list;
}

function counts(source) {
  const s = source || entries;
  return { all: s.length, unread: s.filter(e => !e.state?.read).length, read: s.filter(e => e.state?.read).length };
}

function getCurrentSource() {
  return currentPage === '/starred' ? entries.filter(e => e.state?.starred)
    : currentPage.startsWith('/feed/') ? entries.filter(e => e.feedId === currentPage.slice(6))
    : entries;
}

function getVisibleEntries() {
  return getFiltered(getCurrentSource()).slice(0, loadLimit);
}

function safeHttpUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function openUrl(entry) {
  const url = safeHttpUrl(entry.url);
  if (!url) { toast('Entry has no safe link'); return; }
  window.open(url, '_blank', 'noopener');
}

function entryHtml(entry, i) {
  const read = entry.state?.read;
  const starred = entry.state?.starred;
  const sel = selectedIds.has(entry.id);
  const foc = i === focusedIndex;
  const displayTitle = entry.title || '';
  const displayFeed = entry.feedLabel || '';
  const safeUrl = safeHttpUrl(entry.url);
  const titleHtml = safeUrl
    ? '<a href="' + esc(safeUrl) + '" target="_blank" rel="noopener" class="entry-title" data-entry-link="' + esc(entry.id) + '">' + esc(displayTitle) + '</a>'
    : '<span class="entry-title">' + esc(displayTitle) + '</span>';
  return '<div class="entry-card ' + (read ? 'entry-read' : 'entry-unread') + (sel ? ' entry-selected' : '') + (foc ? ' entry-focused' : '') + '" data-idx="' + i + '" data-id="' + esc(entry.id) + '">'
    + '<label class="entry-checkbox"><input type="checkbox" data-select="' + esc(entry.id) + '"' + (sel ? ' checked' : '') + '></label>'
    + '<span class="entry-leading-space" aria-hidden="true"></span>'
    + '<div class="entry-content">'
    + titleHtml
    + '<span class="entry-meta">' + esc(displayFeed) + ' · ' + timeAgo(entry.published) + '</span>'
    + '</div>'
    + '<div class="entry-actions">'
    + '<button class="btn-icon btn-star' + (starred ? ' starred' : '') + '" data-star="' + esc(entry.id) + '" title="Star">★</button>'
    + '<button class="btn-icon btn-mark" data-mark="' + esc(entry.id) + '" title="' + (read ? 'Mark unread' : 'Mark read') + '">' + (read ? '○' : '●') + '</button>'
    + '</div></div>';
}

function entryListHtml(source) {
  if (initialDataLoading) return '<div class="empty-state">Loading saved entries…</div>';
  const filtered = getFiltered(source);
  if (filtered.length === 0) return '<div class="empty-state">No entries</div>';
  const visible = filtered.slice(0, loadLimit);
  let html = '<div class="entry-list">' + visible.map((e, i) => entryHtml(e, i)).join('') + '</div>';
  if (filtered.length > loadLimit) {
    html += '<div class="load-more"><button class="btn" data-loadmore>Show more (' + (filtered.length - loadLimit) + ' remaining)</button></div>';
  }
  return html;
}

function toolbarHtml(source, showActions) {
  const c = counts(source);
  let html = '<input class="search-input" placeholder="Search entries…" value="' + esc(searchQuery) + '">';
  html += '<div class="toolbar">';
  html += '<div class="filter-tabs">';
  html += '<button data-filter="all"' + (currentFilter === 'all' ? ' class="active"' : '') + '>All (' + c.all + ')</button>';
  html += '<button data-filter="unread"' + (currentFilter === 'unread' ? ' class="active"' : '') + '>Unread (' + c.unread + ')</button>';
  html += '<button data-filter="read"' + (currentFilter === 'read' ? ' class="active"' : '') + '>Read (' + c.read + ')</button>';
  html += '</div>';
  if (showActions) {
    html += '<div class="timeline-actions">';
    html += '<button class="btn" data-openall>Open all unread ↗</button>';
    html += '<button class="btn" data-markall>Mark all read ✓</button>';
    html += '<button class="btn" data-refresh' + (initialDataLoading || refreshStatus?.refreshing ? ' disabled' : '') + '>' + (refreshStatus?.refreshing ? 'Refreshing…' : 'Refresh ↻') + '</button>';
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function renderTimeline() {
  return '<div class="page">' + toolbarHtml(entries, true) + '<div id="entry-list">' + entryListHtml(entries) + '</div></div>';
}

function renderStarred() {
  const starred = entries.filter(e => e.state?.starred);
  return '<div class="page"><div class="page-header"><h1 class="page-title">Starred</h1></div>'
    + '<input class="search-input" placeholder="Search starred…" value="' + esc(searchQuery) + '">'
    + '<div id="entry-list">' + entryListHtml(starred) + '</div></div>';
}

function renderFeedDetail(feedId) {
  const feed = feeds.feeds.find(f => f.id === feedId);
  const feedEntries = entries.filter(e => e.feedId === feedId);
  return '<div class="page"><div class="page-header"><h1 class="page-title">' + esc(feed?.label || 'Feed') + '</h1></div>'
    + toolbarHtml(feedEntries, true) + '<div id="entry-list">' + entryListHtml(feedEntries) + '</div></div>';
}

function renderFeeds() {
  let html = '<div class="page feeds-page"><div class="page-header feeds-header"><div><h1 class="page-title">Feeds</h1>'
    + '<div class="feeds-subtitle">' + feeds.feeds.length + ' sources</div></div></div>';
  html += '<form class="add-form" id="add-feed-form"><input class="search-input" name="url" placeholder="Feed, site URL, or @handle…" required style="margin-bottom:0">';
  html += '<button class="btn btn-primary" type="submit">Add</button></form>';
  html += '<div class="feed-file-actions"><label class="btn" style="cursor:pointer"><input type="file" accept=".opml,.xml" id="opml-input" hidden>Import OPML</label><a href="' + externalPath('/api/feeds/export') + '" class="btn" download="feedreader.opml">Export OPML</a></div>';
  html += '<div class="feed-list">';
  for (const f of feeds.feeds) {
    const unread = entries.filter(e => e.feedId === f.id && !e.state?.read).length;
    const h = feeds.health?.[f.id];
    const lastFetch = h?.lastFetched ? timeAgo(new Date(h.lastFetched).toISOString()) : 'never';
    const healthStatus = h?.error ? '<span class="feed-error" title="' + esc(h.error) + '">Error</span>' : '<span class="feed-ok">Updated ' + lastFetch + '</span>';
    html += '<div class="feed-item"><div class="feed-info">'
      + '<div class="feed-label-row"><a href="' + externalPath('/feed/' + esc(f.id)) + '" data-link class="feed-label">' + esc(f.label) + '</a>' + healthStatus + '</div>'
      + '<div class="feed-meta">' + esc(f.url) + '</div></div>'
      + '<div class="feed-actions">'
      + (unread > 0 ? '<span class="feed-unread-badge">' + unread + '</span>' : '')
      + '<button class="btn btn-feed-delete" data-delete-feed="' + esc(f.id) + '" title="Remove feed">✕</button>'
      + '</div></div>';
  }
  if (feeds.feeds.length === 0) html += '<div class="empty-state">No feeds yet. Add one above!</div>';
  html += '</div></div>';
  return html;
}

function renderSettings() {
  let html = '<div class="page"><div class="page-header"><h1 class="page-title">Settings</h1></div>';
  html += '<form class="settings-form" id="settings-form">';
  html += '<div class="settings-field"><label>Max bulk open tabs</label><input name="maxBulkOpen" type="number" min="1" value="' + CONFIG.maxBulkOpen + '"></div>';
  html += '<div class="settings-field"><label>Max entries to keep</label><input name="maxEntries" type="number" min="100" value="' + CONFIG.retention.maxEntries + '"></div>';
  html += '<div class="settings-field"><label>Max entry age (days, empty = no limit)</label><input name="maxDays" type="number" min="1" value="' + (CONFIG.retention.maxDays || '') + '"></div>';

  html += '<button class="btn btn-primary" type="submit">Save</button>';
  html += '</form></div>';
  return html;
}

function route(path) {
  if (path === '/') return renderTimeline();
  if (path === '/starred') return renderStarred();
  if (path === '/feeds') return renderFeeds();
  if (path.startsWith('/feed/')) return renderFeedDetail(path.slice(6));
  if (path === '/settings') return renderSettings();
  return renderTimeline();
}

function renderCurrentPage() {
  const update = () => {
    updateBulkBar();
    document.getElementById('app').innerHTML = route(currentPage);
    updateNav();
    bindPage();
    updateRefreshIndicator();
  };
  if (document.startViewTransition) document.startViewTransition(update);
  else update();
}

function navigate(path, push) {
  const update = () => {
    currentPage = path;
    loadLimit = 50;
    searchQuery = '';
    currentFilter = 'all';
    selectedIds.clear();
    selectionAnchorId = null;
    focusedIndex = -1;
    keyboardNavigationActive = false;
    updateBulkBar();
    document.getElementById('app').innerHTML = route(path);
    updateNav();
    bindPage();
    updateRefreshIndicator();
  };
  if (document.startViewTransition) document.startViewTransition(update);
  else update();
  if (push !== false) history.pushState({}, '', externalPath(path));
}

function updateNav() {
  document.querySelectorAll('[data-nav]').forEach(a => {
    const href = a.getAttribute('data-nav');
    a.classList.toggle('active', currentPage === href || (href !== '/' && currentPage.startsWith(href)));
  });
  if (currentPage === '/') document.querySelector('[data-nav="/"]')?.classList.add('active');
}

function setNavMenuOpen(open) {
  document.body.classList.toggle('nav-menu-open', open);
  document.querySelector('[data-nav-menu]')?.setAttribute('aria-expanded', String(open));
  const scrim = document.querySelector('[data-nav-scrim]');
  if (scrim) scrim.hidden = !open;
}

function updateBulkBar() {
  const bar = document.getElementById('bulk-bar');
  bar.hidden = selectedIds.size === 0;
  document.body.classList.toggle('bulk-active', selectedIds.size > 0);
  document.getElementById('bulk-count').textContent = selectedIds.size + ' selected';
}

function dismissKeyboardNavigation(e) {
  if (!keyboardNavigationActive || e.pointerType !== 'mouse') return;
  keyboardNavigationActive = false;
  focusedIndex = -1;
  reRenderList();
}

function reRenderList() {
  const el = document.getElementById('entry-list');
  if (!el) return;
  const listEl = el.querySelector('.entry-list');
  const visible = getVisibleEntries();
  if (!listEl || listEl.children.length !== visible.length) {
    el.innerHTML = entryListHtml(getCurrentSource());
    return;
  }
  for (let i = 0; i < visible.length; i++) {
    if (listEl.children[i].dataset.id !== visible[i].id) {
      el.innerHTML = entryListHtml(getCurrentSource());
      return;
    }
  }
  for (let i = 0; i < visible.length; i++) {
    const entry = visible[i];
    const card = listEl.children[i];
    const read = entry.state?.read;
    const starred = entry.state?.starred;
    const sel = selectedIds.has(entry.id);
    const foc = i === focusedIndex;
    card.className = 'entry-card ' + (read ? 'entry-read' : 'entry-unread') + (sel ? ' entry-selected' : '') + (foc ? ' entry-focused' : '');
    const cb = card.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = sel;
    const starBtn = card.querySelector('.btn-star');
    if (starBtn) starBtn.classList.toggle('starred', !!starred);
    const markBtn = card.querySelector('.btn-mark');
    if (markBtn) { markBtn.textContent = read ? '○' : '●'; markBtn.title = read ? 'Mark unread' : 'Mark read'; }
  }
}

function updateToolbarCounts() {
  const toolbar = document.querySelector('.toolbar');
  if (!toolbar) return;
  const source = getCurrentSource();
  const c = counts(source);
  toolbar.querySelectorAll('[data-filter]').forEach(b => {
    const f = b.dataset.filter;
    const n = f === 'all' ? c.all : f === 'unread' ? c.unread : c.read;
    b.textContent = f.charAt(0).toUpperCase() + f.slice(1) + ' (' + n + ')';
    b.classList.toggle('active', f === currentFilter);
  });
}

function setEntrySelected(id, selected) {
  if (selected) selectedIds.add(id);
  else selectedIds.delete(id);
}

function toggleEntrySelection(id, idx, useRange) {
  const visible = getVisibleEntries();
  const shouldSelect = !selectedIds.has(id);
  if (useRange) {
    const anchorIdx = selectionAnchorId ? visible.findIndex(v => v.id === selectionAnchorId) : 0;
    if (anchorIdx !== -1 && idx !== -1 && visible.length > 0) {
      const [start, end] = anchorIdx < idx ? [anchorIdx, idx] : [idx, anchorIdx];
      for (let i = start; i <= end; i++) {
        setEntrySelected(visible[i].id, shouldSelect);
      }
      selectionAnchorId = id;
      reRenderList();
      updateBulkBar();
      return;
    }
  }
  setEntrySelected(id, shouldSelect);
  selectionAnchorId = id;
  reRenderList();
  updateBulkBar();
}

function applyDragSelectionToIndex(idx) {
  if (!selectionDrag || idx < 0) return;
  const visible = getVisibleEntries();
  if (idx >= visible.length) return;
  const [start, end] = selectionDrag.lastIdx < idx ? [selectionDrag.lastIdx, idx] : [idx, selectionDrag.lastIdx];
  for (let i = start; i <= end; i++) {
    setEntrySelected(visible[i].id, selectionDrag.selecting);
  }
  selectionDrag.lastIdx = idx;
  selectionAnchorId = visible[idx].id;
  reRenderList();
  updateBulkBar();
}

function dragSelectionIndexFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  const card = el?.closest?.('.entry-card');
  if (!card) return -1;
  return Number.parseInt(card.dataset.idx, 10);
}

async function markEntries(ids, updates) {
  const map = {};
  const previous = new Map();
  for (const id of ids) {
    map[id] = updates;
    const e = entries.find(x => x.id === id);
    if (e) {
      previous.set(id, e.state ? { ...e.state } : {});
      if ('read' in updates) { e.state = { ...e.state, read: updates.read, readAt: Date.now() }; }
      if ('starred' in updates) { e.state = { ...e.state, starred: updates.starred, starredAt: Date.now() }; }
    }
  }
  reRenderList();
  updateToolbarCounts();
  try {
    await api('POST', '/api/state', { entries: map });
    return true;
  } catch (err) {
    for (const [id, state] of previous) {
      const e = entries.find(x => x.id === id);
      if (e) e.state = state;
    }
    reRenderList();
    updateToolbarCounts();
    toast('Could not save state: ' + err.message);
    return false;
  }
}

function bindPage() {
  const app = document.getElementById('app');

  const searchInput = app.querySelector('.search-input:not([name])') || app.querySelector('.search-input[placeholder*="Search"]');
  if (searchInput && !searchInput.getAttribute('name')) {
    const onSearch = debounce(() => { searchQuery = searchInput.value.trim(); reRenderList(); }, 120);
    searchInput.addEventListener('input', onSearch);
  }

  if (!app.dataset.clickBound) {
    app.dataset.clickBound = '1';
    app.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.shiftKey) return;
      const checkbox = e.target.closest('.entry-checkbox')?.querySelector('[data-select]');
      if (!checkbox) return;
      const card = checkbox.closest('.entry-card');
      const idx = card ? Number.parseInt(card.dataset.idx, 10) : -1;
      if (idx < 0) return;
      e.preventDefault();
      const id = checkbox.dataset.select;
      selectionDrag = {
        pointerId: e.pointerId,
        selecting: !selectedIds.has(id),
        lastIdx: idx,
      };
      app.setPointerCapture?.(e.pointerId);
      suppressNextSelectClick = true;
      document.querySelector('.entry-list')?.classList.add('is-selecting');
      setEntrySelected(id, selectionDrag.selecting);
      selectionAnchorId = id;
      reRenderList();
      updateBulkBar();
    });

    app.addEventListener('pointermove', (e) => {
      if (!selectionDrag || e.pointerId !== selectionDrag.pointerId) return;
      e.preventDefault();
      applyDragSelectionToIndex(dragSelectionIndexFromPoint(e.clientX, e.clientY));
    });

    const endDragSelection = (e) => {
      if (!selectionDrag || e.pointerId !== selectionDrag.pointerId) return;
      selectionDrag = null;
      app.releasePointerCapture?.(e.pointerId);
      document.querySelector('.entry-list')?.classList.remove('is-selecting');
      setTimeout(() => { suppressNextSelectClick = false; }, 0);
    };
    app.addEventListener('pointerup', endDragSelection);
    app.addEventListener('pointercancel', endDragSelection);

    app.addEventListener('click', async (e) => {
      const target = e.target;

    const entryLink = target.closest('[data-entry-link]');
    if (entryLink) {
      e.preventDefault();
      const id = entryLink.dataset.entryLink;
      const entry = entries.find(x => x.id === id);
      if (entry) {
        openUrl(entry);
        void markEntries([id], { read: true });
      }
      return;
    }

    const filterBtn = target.closest('[data-filter]');
    if (filterBtn) { currentFilter = filterBtn.dataset.filter; loadLimit = 50; reRenderList(); app.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === currentFilter)); return; }

    const selectBox = target.closest('[data-select]');
    if (selectBox) {
      if (suppressNextSelectClick) {
        e.preventDefault();
        return;
      }
      const id = selectBox.dataset.select;
      const card = selectBox.closest('.entry-card');
      const idx = card ? parseInt(card.dataset.idx, 10) : -1;
      toggleEntrySelection(id, idx, e.shiftKey);
      return;
    }

    const starBtn = target.closest('[data-star]');
    if (starBtn) { const id = starBtn.dataset.star; const e2 = entries.find(x => x.id === id); await markEntries([id], { starred: !e2?.state?.starred }); return; }

    const markBtn = target.closest('[data-mark]');
    if (markBtn) { const id = markBtn.dataset.mark; const e2 = entries.find(x => x.id === id); await markEntries([id], { read: !e2?.state?.read }); return; }

    const loadMore = target.closest('[data-loadmore]');
    if (loadMore) { loadLimit += 50; reRenderList(); return; }

    const openAll = target.closest('[data-openall]');
    if (openAll) {
      const unread = getFiltered(getCurrentSource()).filter(x => !x.state?.read);
      if (unread.length === 0) { toast('No unread entries'); return; }
      const toOpen = unread.slice(0, CONFIG.maxBulkOpen);
      if (unread.length > CONFIG.maxBulkOpen) {
        if (!confirm(unread.length + ' unread entries. Open first ' + CONFIG.maxBulkOpen + '?')) return;
      }
      for (const entry of toOpen) openUrl(entry);
      await markEntries(toOpen.map(x => x.id), { read: true });
      return;
    }

    const markAll = target.closest('[data-markall]');
    if (markAll) {
      const unread = getFiltered(getCurrentSource()).filter(x => !x.state?.read);
      if (unread.length === 0) return;
      if (await markEntries(unread.map(x => x.id), { read: true })) {
        toast(unread.length + ' marked as read');
      }
      return;
    }

    const refreshBtn = target.closest('[data-refresh]');
    if (refreshBtn) {
      try {
        const r = await refreshData();
        if (r.error) toast('Refresh failed: ' + r.error);
      } catch (err) {
        refreshStatus = { refreshing: false, error: err.message, count: 0, failed: 0 };
        toast('Refresh failed: ' + err.message);
      } finally {
        updateRefreshIndicator();
      }
      return;
    }

    const delFeed = target.closest('[data-delete-feed]');
    if (delFeed) {
      if (!confirm('Remove this feed?')) return;
      await api('DELETE', '/api/feeds/' + delFeed.dataset.deleteFeed);
      entries = await api('GET', '/api/entries');
      feeds = await api('GET', '/api/feeds');
      navigate('/feeds', false);
      toast('Feed removed');
      return;
    }
    });
  }

  const addForm = document.getElementById('add-feed-form');
  if (addForm) {
    addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(addForm);
      try {
        await api('POST', '/api/feeds', { url: fd.get('url') });
        entries = await api('GET', '/api/entries');
        feeds = await api('GET', '/api/feeds');
        navigate('/feeds', false);
        toast('Feed added!');
      } catch (err) { toast('Error: ' + err.message); }
    });
  }

  const opmlInput = document.getElementById('opml-input');
  if (opmlInput) {
    opmlInput.addEventListener('change', async () => {
      const file = opmlInput.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      try {
        const r = await api('POST', '/api/feeds/import', fd);
        feeds = await api('GET', '/api/feeds');
        navigate('/feeds', false);
        toast(r.added + ' feeds imported, ' + r.skipped + ' skipped');
      } catch (err) { toast('Error: ' + err.message); }
    });
  }

  const settingsForm = document.getElementById('settings-form');
  if (settingsForm) {
    settingsForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(settingsForm);
      const updated = {
        maxBulkOpen: parseInt(fd.get('maxBulkOpen')) || 20,
        retention: {
          maxEntries: parseInt(fd.get('maxEntries')) || 3000,
          maxDays: parseInt(fd.get('maxDays')) || null,
        },
      };
      const saved = await api('PUT', '/api/config', updated);
      Object.assign(CONFIG, saved);
      const themeLink = document.getElementById('theme-link');
      if (themeLink) themeLink.href = BASE_PATH + '/api/theme?t=' + Date.now();
      toast('Settings saved!');
    });
  }
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const active = document.activeElement;
  const typingContext = !!active && (
    active.matches?.('input,textarea,select,[contenteditable="true"]')
  );
  if (typingContext) {
    if (e.key === 'Escape') {
      active.blur();
      e.preventDefault();
    }
    return;
  }

  if (active && active !== document.body && !active.closest('.entry-card')) active.blur();

  const filtered = getFiltered(getCurrentSource());
  const hasFocused = focusedIndex >= 0 && focusedIndex < filtered.length;
  const key = e.key.toLowerCase();
  const visibleMax = Math.min(filtered.length, loadLimit);

  if (key === 'j') {
    keyboardNavigationActive = true;
    if (e.shiftKey && focusedIndex >= 0 && focusedIndex < visibleMax) {
      selectedIds.add(filtered[focusedIndex].id);
    }
    focusedIndex = Math.min(focusedIndex + 1, visibleMax - 1);
    if (e.shiftKey && focusedIndex >= 0 && focusedIndex < visibleMax) {
      selectedIds.add(filtered[focusedIndex].id);
      selectionAnchorId = filtered[focusedIndex].id;
      updateBulkBar();
    }
    reRenderList();
    const el = document.querySelector('.entry-focused');
    if (el) el.scrollIntoView({ block: 'nearest' });
    e.preventDefault();
  } else if (key === 'k') {
    keyboardNavigationActive = true;
    if (e.shiftKey && focusedIndex >= 0 && focusedIndex < visibleMax) {
      selectedIds.add(filtered[focusedIndex].id);
    }
    focusedIndex = Math.max(focusedIndex - 1, 0);
    if (e.shiftKey && focusedIndex >= 0 && focusedIndex < visibleMax) {
      selectedIds.add(filtered[focusedIndex].id);
      selectionAnchorId = filtered[focusedIndex].id;
      updateBulkBar();
    }
    reRenderList();
    const el = document.querySelector('.entry-focused');
    if (el) el.scrollIntoView({ block: 'nearest' });
    e.preventDefault();
  } else if (key === 'o' && hasFocused) {
    const entry = filtered[focusedIndex];
    openUrl(entry);
    void markEntries([entry.id], { read: true });
    e.preventDefault();
  } else if (key === 'm' && hasFocused) {
    const entry = filtered[focusedIndex];
    markEntries([entry.id], { read: !entry.state?.read });
    e.preventDefault();
  } else if (key === 's' && hasFocused) {
    const entry = filtered[focusedIndex];
    markEntries([entry.id], { starred: !entry.state?.starred });
    e.preventDefault();
  } else if (key === 'x' && hasFocused) {
    const entry = filtered[focusedIndex];
    if (selectedIds.has(entry.id)) selectedIds.delete(entry.id); else selectedIds.add(entry.id);
    updateBulkBar();
    reRenderList();
    e.preventDefault();
  } else if (key === 'a') {
    const unread = filtered.filter(x => !x.state?.read);
    if (unread.length > 0) {
      markEntries(unread.map(x => x.id), { read: true }).then((ok) => {
        if (ok) toast(unread.length + ' marked as read');
      });
    }
    e.preventDefault();
  } else if (key === 'r') {
    document.querySelector('[data-refresh]')?.click();
    e.preventDefault();
  } else if (e.key === '/') {
    document.querySelector('.search-input')?.focus();
    e.preventDefault();
  } else if (e.key === '?') {
    document.getElementById('shortcuts-overlay').hidden = !document.getElementById('shortcuts-overlay').hidden;
    e.preventDefault();
  } else if (e.key === 'Escape') {
    selectedIds.clear();
    updateBulkBar();
    setNavMenuOpen(false);
    document.getElementById('shortcuts-overlay').hidden = true;
    focusedIndex = -1;
    keyboardNavigationActive = false;
    reRenderList();
    e.preventDefault();
  }
});

document.addEventListener('pointerdown', dismissKeyboardNavigation, true);
document.addEventListener('pointermove', dismissKeyboardNavigation, { capture: true, passive: true });

// Bulk bar
document.getElementById('bulk-read').onclick = () => { markEntries([...selectedIds], { read: true }); selectedIds.clear(); updateBulkBar(); };
document.getElementById('bulk-unread').onclick = () => { markEntries([...selectedIds], { read: false }); selectedIds.clear(); updateBulkBar(); };
document.getElementById('bulk-star').onclick = () => { markEntries([...selectedIds], { starred: true }); selectedIds.clear(); updateBulkBar(); };
document.getElementById('bulk-open').onclick = () => {
  let toOpen = entries.filter(e => selectedIds.has(e.id));
  if (toOpen.length > CONFIG.maxBulkOpen) {
    if (!confirm(toOpen.length + ' selected. Open first ' + CONFIG.maxBulkOpen + '?')) return;
    toOpen = toOpen.slice(0, CONFIG.maxBulkOpen);
  }
  for (const e of toOpen) openUrl(e);
  void markEntries(toOpen.map(e => e.id), { read: true });
  selectedIds.clear(); updateBulkBar(); reRenderList();
};
document.getElementById('bulk-cancel').onclick = () => { selectedIds.clear(); updateBulkBar(); reRenderList(); };

// Nav links
document.body.addEventListener('click', (e) => {
  const menuButton = e.target.closest('[data-nav-menu]');
  if (menuButton) {
    setNavMenuOpen(!document.body.classList.contains('nav-menu-open'));
    return;
  }

  if (e.target.closest('[data-nav-scrim]')) {
    setNavMenuOpen(false);
    return;
  }

  const link = e.target.closest('[data-link]');
  if (link) { e.preventDefault(); setNavMenuOpen(false); navigate(internalPath(link.getAttribute('href'))); }
});

// Popstate
window.addEventListener('popstate', () => navigate(internalPath(location.pathname), false));

async function syncExternalTheme() {
  try {
    const latest = await api('GET', '/api/config');
    if (latest.theme === CONFIG.theme) return;
    CONFIG.theme = latest.theme;
    const themeLink = document.getElementById('theme-link');
    if (themeLink) themeLink.href = BASE_PATH + '/api/theme?t=' + Date.now();
    if (currentPage === '/settings') renderCurrentPage();
  } catch {}
}

setInterval(syncExternalTheme, 2000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void syncExternalTheme();
});

// Init
(async () => {
  navigate(internalPath(location.pathname), false);
  const feedsPromise = api('GET', '/api/feeds');
  entries = await api('GET', '/api/entries');
  initialDataLoading = false;
  renderCurrentPage();
  feeds = await feedsPromise;
  if (currentPage === '/feeds' || currentPage.startsWith('/feed/')) renderCurrentPage();

  // Auto-refresh feeds after initial load
  try {
    const r = await refreshData();
    if (r.error) toast('Refresh failed: ' + r.error);
  } catch (err) {
    refreshStatus = { refreshing: false, error: err.message, count: 0, failed: 0 };
    updateRefreshIndicator();
  }
})();
</script>
</body>
</html>`;
}
