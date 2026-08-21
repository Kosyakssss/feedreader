export function renderApp(basePath = ''): string {
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
      <kbd>?</kbd><span>Show shortcuts</span>
      <kbd>Esc</kbd><span>Close / clear</span>
    </div>
    <button class="btn" onclick="document.getElementById('shortcuts-overlay').hidden=true">Close</button>
  </div>
</div>
<div class="toast-container" id="toast-container"></div>

<script src="${basePath}/app.js" defer></script>
</body>
</html>`;
}
