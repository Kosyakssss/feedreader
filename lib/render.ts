import { faviconDataUri, renderIcon, renderIconSprite } from './icons.ts';

export function renderApp(basePath = '', assetVersion = ''): string {
  const assetQuery = assetVersion ? `?v=${encodeURIComponent(assetVersion)}` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="${faviconDataUri()}">
<title>Feedreader</title>
<meta name="description" content="A personal feed reader">
<meta name="application-name" content="Feedreader">
<meta property="og:title" content="Feedreader">
<meta property="og:site_name" content="Feedreader">
<link rel="stylesheet" href="${basePath}/api/theme" id="theme-link">
<link rel="stylesheet" href="${basePath}/app.css${assetQuery}">
</head>
<body>
${renderIconSprite()}
<nav class="nav-bar">
  <a href="${basePath}/" class="nav-logo" data-link>${renderIcon('bookmark', 'ui-icon nav-logo-icon')}<span>Feedreader</span></a>
  <button class="refresh-status" id="refresh-status" type="button" data-refresh-status data-phase="loading" aria-label="Loading saved entries" aria-expanded="false">
    <span class="refresh-label" data-refresh-label></span>
    <span class="refresh-graphic" data-refresh-graphic aria-hidden="true">
      <span class="refresh-bar"></span>
      <span class="refresh-bar"></span>
      <span class="refresh-bar"></span>
      <span class="refresh-bar"></span>
    </span>
    <span class="visually-hidden" data-refresh-live role="status" aria-live="polite"></span>
  </button>
  <button class="nav-menu-button" type="button" aria-label="Open navigation" aria-expanded="false" data-nav-menu>${renderIcon('menu')}</button>
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
  <button class="btn" id="bulk-read" data-bulk="read">Mark read</button>
  <button class="btn" id="bulk-unread" data-bulk="unread">Mark unread</button>
  <button class="btn" id="bulk-open" data-bulk="open">Open${renderIcon('external-link', 'ui-icon button-icon')}</button>
  <button class="btn" id="bulk-star" data-bulk="star">${renderIcon('star', 'ui-icon button-icon')}Star</button>
  <button class="btn" id="bulk-cancel" data-bulk="cancel">Cancel</button>
</div>
<div id="shortcuts-overlay" class="shortcuts-overlay" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" hidden>
  <div class="shortcuts-panel">
    <h2 id="shortcuts-title">Keyboard Shortcuts</h2>
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
    <button class="btn" data-shortcuts-close>Close</button>
  </div>
</div>
<div class="toast-container" id="toast-container" role="status" aria-live="polite" aria-atomic="true"></div>

<script src="${basePath}/app.js${assetQuery}" type="module"></script>
</body>
</html>`;
}
