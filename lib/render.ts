import type { Config, ThemeMeta } from './types.ts';

function safeJsonForScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

export function renderApp(config: Config, themes: ThemeMeta[]): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔖</text></svg>">
<title>Feedreader</title>
<link rel="stylesheet" href="/api/theme" id="theme-link">
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
  <a href="/" class="nav-logo" data-link>🔖 Feedreader</a>
  <div class="nav-links">
    <a href="/" data-link class="nav-link" data-nav="/">Timeline</a>
    <a href="/starred" data-link class="nav-link" data-nav="/starred">Starred</a>
    <a href="/feeds" data-link class="nav-link" data-nav="/feeds">Feeds</a>
    <a href="/settings" data-link class="nav-link" data-nav="/settings">Settings</a>
  </div>
</nav>
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
      <kbd>o</kbd><span>Open (default action)</span>
      <kbd>O</kbd><span>Open (alt action)</span>
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
const THEMES = ${safeJsonForScript(themes)};

let entries = [];
let feeds = { folders: [], feeds: [] };
let selectedIds = new Set();
let focusedIndex = -1;
let searchQuery = '';
let currentFilter = 'all';
let currentPage = '';
let loadLimit = 50;
let selectionAnchorId = null;

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
  const res = await fetch(path, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || data || res.statusText);
  return data;
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

function openUrl(entry, alt) {
  const defuddled = alt ? CONFIG.defaultOpenAction !== 'defuddled' : CONFIG.defaultOpenAction === 'defuddled';
  const url = defuddled ? '/read?url=' + encodeURIComponent(entry.url) : entry.url;
  window.open(url, '_blank', 'noopener');
}

function entryHtml(entry, i) {
  const read = entry.state?.read;
  const starred = entry.state?.starred;
  const sel = selectedIds.has(entry.id);
  const foc = i === focusedIndex;
  const displayTitle = entry.title || '';
  const displayFeed = entry.feedLabel || '';
  return '<div class="entry-card ' + (read ? 'entry-read' : 'entry-unread') + (foc ? ' entry-focused' : '') + '" data-idx="' + i + '" data-id="' + esc(entry.id) + '">'
    + '<label class="entry-checkbox"><input type="checkbox" data-select="' + esc(entry.id) + '"' + (sel ? ' checked' : '') + '></label>'
    + '<span class="entry-leading-space" aria-hidden="true"></span>'
    + '<div class="entry-content">'
    + '<a href="' + esc(entry.url) + '" target="_blank" rel="noopener" class="entry-title" data-entry-link="' + esc(entry.id) + '">' + esc(displayTitle) + '</a>'
    + '<span class="entry-meta">' + esc(displayFeed) + ' · ' + timeAgo(entry.published) + '</span>'
    + '</div>'
    + '<div class="entry-actions">'
    + '<button class="btn-icon btn-star' + (starred ? ' starred' : '') + '" data-star="' + esc(entry.id) + '" title="Star">★</button>'
    + '<button class="btn-icon btn-mark" data-mark="' + esc(entry.id) + '" title="' + (read ? 'Mark unread' : 'Mark read') + '">' + (read ? '○' : '●') + '</button>'
    + '</div></div>';
}

function entryListHtml(source) {
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
    html += '<button class="btn" data-refresh>Refresh ↻</button>';
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
  let html = '<div class="page"><div class="page-header"><h1 class="page-title">Feeds</h1></div>';
  html += '<form class="add-form" id="add-feed-form"><input class="search-input" name="url" placeholder="Feed or site URL…" required style="margin-bottom:0">';
  html += '<input class="search-input" name="label" placeholder="Label (optional)" style="margin-bottom:0;max-width:160px">';
  html += '<button class="btn btn-primary" type="submit">Add</button></form>';
  html += '<div style="margin-bottom:var(--spacing-md)"><label class="btn" style="cursor:pointer"><input type="file" accept=".opml,.xml" id="opml-input" hidden>Import OPML</label></div>';
  html += '<div class="feed-list">';
  for (const f of feeds.feeds) {
    const unread = entries.filter(e => e.feedId === f.id && !e.state?.read).length;
    html += '<div class="feed-item"><div class="feed-info">'
      + '<div class="feed-label">' + esc(f.label) + '</div>'
      + '<div class="feed-meta">' + esc(f.url) + '</div></div>'
      + '<div class="feed-actions">'
      + (unread > 0 ? '<span class="feed-unread-badge">' + unread + '</span>' : '')
      + '<a href="/feed/' + esc(f.id) + '" data-link class="btn">View →</a>'
      + '<button class="btn" data-delete-feed="' + esc(f.id) + '">✕</button>'
      + '</div></div>';
  }
  if (feeds.feeds.length === 0) html += '<div class="empty-state">No feeds yet. Add one above!</div>';
  html += '</div></div>';
  return html;
}

function renderSettings() {
  let html = '<div class="page"><div class="page-header"><h1 class="page-title">Settings</h1></div>';
  html += '<form class="settings-form" id="settings-form">';
  html += '<div class="settings-field"><label>Default open action</label><select name="defaultOpenAction">'
    + '<option value="original"' + (CONFIG.defaultOpenAction === 'original' ? ' selected' : '') + '>Original page</option>'
    + '<option value="defuddled"' + (CONFIG.defaultOpenAction === 'defuddled' ? ' selected' : '') + '>Defuddled</option></select></div>';
  html += '<div class="settings-field"><label>Max bulk open tabs</label><input name="maxBulkOpen" type="number" min="1" value="' + CONFIG.maxBulkOpen + '"></div>';
  html += '<div class="settings-field"><label>Max entries to keep</label><input name="maxEntries" type="number" min="100" value="' + CONFIG.retention.maxEntries + '"></div>';
  html += '<div class="settings-field"><label>Max entry age (days, empty = no limit)</label><input name="maxDays" type="number" min="1" value="' + (CONFIG.retention.maxDays || '') + '"></div>';
  html += '<div class="settings-field"><label>Theme</label><select name="theme"><option value="">Default</option>';
  for (const t of THEMES) {
    if (t.file === 'default') continue;
    html += '<option value="' + esc(t.file) + '"' + (CONFIG.theme === t.file ? ' selected' : '') + '>' + esc(t.name) + '</option>';
  }
  html += '</select></div>';
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

function navigate(path, push) {
  const update = () => {
    currentPage = path;
    loadLimit = 50;
    searchQuery = '';
    currentFilter = 'all';
    selectedIds.clear();
    selectionAnchorId = null;
    focusedIndex = -1;
    updateBulkBar();
    document.getElementById('app').innerHTML = route(path);
    updateNav();
    bindPage();
  };
  if (document.startViewTransition) document.startViewTransition(update);
  else update();
  if (push !== false) history.pushState({}, '', path);
}

function updateNav() {
  document.querySelectorAll('[data-nav]').forEach(a => {
    const href = a.getAttribute('data-nav');
    a.classList.toggle('active', currentPage === href || (href !== '/' && currentPage.startsWith(href)));
  });
  if (currentPage === '/') document.querySelector('[data-nav="/"]')?.classList.add('active');
}

function updateBulkBar() {
  const bar = document.getElementById('bulk-bar');
  bar.hidden = selectedIds.size === 0;
  document.getElementById('bulk-count').textContent = selectedIds.size + ' selected';
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
    const entry = visible[i];
    const card = listEl.children[i];
    const read = entry.state?.read;
    const starred = entry.state?.starred;
    const sel = selectedIds.has(entry.id);
    const foc = i === focusedIndex;
    card.className = 'entry-card ' + (read ? 'entry-read' : 'entry-unread') + (foc ? ' entry-focused' : '');
    const cb = card.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = sel;
    const starBtn = card.querySelector('.btn-star');
    if (starBtn) starBtn.classList.toggle('starred', !!starred);
    const markBtn = card.querySelector('.btn-mark');
    if (markBtn) { markBtn.textContent = read ? '○' : '●'; markBtn.title = read ? 'Mark unread' : 'Mark read'; }
  }
}

async function markEntries(ids, updates) {
  const map = {};
  for (const id of ids) {
    map[id] = updates;
    const e = entries.find(x => x.id === id);
    if (e) {
      if ('read' in updates) { e.state = { ...e.state, read: updates.read, readAt: Date.now() }; }
      if ('starred' in updates) { e.state = { ...e.state, starred: updates.starred, starredAt: Date.now() }; }
    }
  }
  reRenderList();
  const toolbar = document.querySelector('.toolbar');
  if (toolbar) {
    const source = getCurrentSource();
    const c = counts(source);
    toolbar.querySelectorAll('[data-filter]').forEach(b => {
      const f = b.dataset.filter;
      const n = f === 'all' ? c.all : f === 'unread' ? c.unread : c.read;
      b.textContent = f.charAt(0).toUpperCase() + f.slice(1) + ' (' + n + ')';
      b.classList.toggle('active', f === currentFilter);
    });
  }
  await api('POST', '/api/state', { entries: map });
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
    app.addEventListener('click', async (e) => {
      const target = e.target;

    const entryLink = target.closest('[data-entry-link]');
    if (entryLink) {
      e.preventDefault();
      const id = entryLink.dataset.entryLink;
      const entry = entries.find(x => x.id === id);
      if (entry) {
        openUrl(entry, false);
        void markEntries([id], { read: true });
      }
      return;
    }

    const filterBtn = target.closest('[data-filter]');
    if (filterBtn) { currentFilter = filterBtn.dataset.filter; loadLimit = 50; reRenderList(); app.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === currentFilter)); return; }

    const selectBox = target.closest('[data-select]');
    if (selectBox) {
      const id = selectBox.dataset.select;
      const visible = getVisibleEntries();
      const card = selectBox.closest('.entry-card');
      const idx = card ? parseInt(card.dataset.idx, 10) : -1;
      const shouldSelect = !selectedIds.has(id);

      if (e.shiftKey) {
        const anchorIdx = selectionAnchorId ? visible.findIndex(v => v.id === selectionAnchorId) : 0;
        if (anchorIdx !== -1 && idx !== -1 && visible.length > 0) {
          const [start, end] = anchorIdx < idx ? [anchorIdx, idx] : [idx, anchorIdx];
          for (let i = start; i <= end; i++) {
            if (shouldSelect) selectedIds.add(visible[i].id);
            else selectedIds.delete(visible[i].id);
          }
          selectionAnchorId = id;
          reRenderList();
          updateBulkBar();
          return;
        }
      }

      if (shouldSelect) selectedIds.add(id); else selectedIds.delete(id);
      selectionAnchorId = id;
      updateBulkBar();
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
      const unread = getFiltered().filter(x => !x.state?.read);
      if (unread.length === 0) { toast('No unread entries'); return; }
      if (unread.length > CONFIG.maxBulkOpen) {
        if (!confirm('Open ' + unread.length + ' tabs? Limit is ' + CONFIG.maxBulkOpen + '.\\nOpen first ' + CONFIG.maxBulkOpen + '?')) return;
        unread.splice(CONFIG.maxBulkOpen);
      }
      for (const entry of unread) openUrl(entry, false);
      await markEntries(unread.map(x => x.id), { read: true });
      return;
    }

    const markAll = target.closest('[data-markall]');
    if (markAll) {
      const unread = getFiltered().filter(x => !x.state?.read);
      if (unread.length === 0) return;
      await markEntries(unread.map(x => x.id), { read: true });
      toast(unread.length + ' marked as read');
      return;
    }

    const refreshBtn = target.closest('[data-refresh]');
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Refreshing…';
      toast('Refreshing feeds…');
      const r = await api('POST', '/api/refresh');
      entries = await api('GET', '/api/entries');
      feeds = await api('GET', '/api/feeds');
      toast(r.count + ' new entries');
      navigate(currentPage, false);
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
        await api('POST', '/api/feeds', { url: fd.get('url'), label: fd.get('label') || undefined });
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
        defaultOpenAction: fd.get('defaultOpenAction'),
        maxBulkOpen: parseInt(fd.get('maxBulkOpen')) || 20,
        retention: {
          maxEntries: parseInt(fd.get('maxEntries')) || 3000,
          maxDays: parseInt(fd.get('maxDays')) || null,
        },
        theme: fd.get('theme') || null,
      };
      const saved = await api('PUT', '/api/config', updated);
      Object.assign(CONFIG, saved);
      document.getElementById('theme-link').href = '/api/theme?t=' + Date.now();
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

  const filtered = getFiltered();
  const hasFocused = focusedIndex >= 0 && focusedIndex < filtered.length;
  const key = e.key.toLowerCase();

  if (key === 'j') {
    if (e.shiftKey && focusedIndex >= 0 && focusedIndex < filtered.length) {
      selectedIds.add(filtered[focusedIndex].id);
    }
    focusedIndex = Math.min(focusedIndex + 1, Math.min(filtered.length, loadLimit) - 1);
    if (e.shiftKey && focusedIndex >= 0 && focusedIndex < filtered.length) {
      selectedIds.add(filtered[focusedIndex].id);
      selectionAnchorId = filtered[focusedIndex].id;
      updateBulkBar();
    }
    reRenderList();
    const el = document.querySelector('.entry-focused');
    if (el) el.scrollIntoView({ block: 'nearest' });
    e.preventDefault();
  } else if (key === 'k') {
    if (e.shiftKey && focusedIndex >= 0 && focusedIndex < filtered.length) {
      selectedIds.add(filtered[focusedIndex].id);
    }
    focusedIndex = Math.max(focusedIndex - 1, 0);
    if (e.shiftKey && focusedIndex >= 0 && focusedIndex < filtered.length) {
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
    openUrl(entry, !!e.shiftKey);
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
    if (unread.length > 0) markEntries(unread.map(x => x.id), { read: true });
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
    document.getElementById('shortcuts-overlay').hidden = true;
    focusedIndex = -1;
    reRenderList();
    e.preventDefault();
  }
});

// Bulk bar
document.getElementById('bulk-read').onclick = () => { markEntries([...selectedIds], { read: true }); selectedIds.clear(); updateBulkBar(); };
document.getElementById('bulk-unread').onclick = () => { markEntries([...selectedIds], { read: false }); selectedIds.clear(); updateBulkBar(); };
document.getElementById('bulk-star').onclick = () => { markEntries([...selectedIds], { starred: true }); selectedIds.clear(); updateBulkBar(); };
document.getElementById('bulk-open').onclick = () => {
  const toOpen = entries.filter(e => selectedIds.has(e.id));
  if (toOpen.length > CONFIG.maxBulkOpen && !confirm('Open ' + toOpen.length + ' tabs?')) return;
  for (const e of toOpen) openUrl(e, false);
  void markEntries([...selectedIds], { read: true });
};
document.getElementById('bulk-cancel').onclick = () => { selectedIds.clear(); updateBulkBar(); reRenderList(); };

// Nav links
document.body.addEventListener('click', (e) => {
  const link = e.target.closest('[data-link]');
  if (link) { e.preventDefault(); navigate(link.getAttribute('href')); }
});

// Popstate
window.addEventListener('popstate', () => navigate(location.pathname, false));

// Init
(async () => {
  [feeds, entries] = await Promise.all([api('GET', '/api/feeds'), api('GET', '/api/entries')]);
  navigate(location.pathname, false);

  // Auto-refresh feeds after initial load
  try {
    toast('Refreshing feeds…');
    const r = await api('POST', '/api/refresh');
    entries = await api('GET', '/api/entries');
    feeds = await api('GET', '/api/feeds');
    if (r.count > 0) toast(r.count + ' new entries');
    reRenderList();
    const toolbar = document.querySelector('.toolbar');
    if (toolbar) {
      const source = getCurrentSource();
      const c = counts(source);
      toolbar.querySelectorAll('[data-filter]').forEach(b => {
        const f = b.dataset.filter;
        const n = f === 'all' ? c.all : f === 'unread' ? c.unread : c.read;
        b.textContent = f.charAt(0).toUpperCase() + f.slice(1) + ' (' + n + ')';
        b.classList.toggle('active', f === currentFilter);
      });
    }
  } catch {}
})();
</script>
</body>
</html>`;
}
