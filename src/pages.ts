// What every page looks like.
import { displayTitle, type Entry, type Source } from './store';

class Html {
  constructor(readonly value: string) {}
}

type Part = Html | string | number | boolean | null | undefined | Part[];

function render(part: Part): string {
  if (part instanceof Html) return part.value;
  if (Array.isArray(part)) return part.map(render).join('');
  if (part === null || part === undefined || part === false || part === true) return '';
  return Bun.escapeHTML(String(part));
}

// Text inserted into this template is escaped; nested html`` is kept as it is.
export function html(strings: TemplateStringsArray, ...parts: Part[]): Html {
  return new Html(strings.reduce((out, text, index) => out + text + render(parts[index]), ''));
}

const MAX_TITLE = 240;

// Very long text keeps its true start and true end, so the part that says how
// it ends can still be shown.
function capTitle(text: string): string {
  const letters = [...text];
  if (letters.length <= MAX_TITLE) return text;
  const keep = Math.floor(MAX_TITLE * 0.618);
  return `${letters.slice(0, keep).join('')} … ${letters.slice(letters.length - (MAX_TITLE - keep)).join('')}`;
}

function dateLabel(ms: number): string {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

const titleLink = (entry: Entry) => html`<a class="title" href="${entry.url}" target="_blank" rel="noopener">${capTitle(displayTitle(entry))}</a>`;
const feedAndDate = (entry: Entry) => html`<small><a href="/feed/${entry.source_id}">${entry.feed}</a> ${dateLabel(entry.published_at)}</small>`;

export function row(entry: Entry): Html {
  const saved = entry.state === 'bookmarked';
  return html`
    <li id="e${entry.id}">
      <div class="row" style="view-transition-name: e${entry.id}">
        ${titleLink(entry)}
        ${feedAndDate(entry)}
        <button
          ${saved ? html`class="saved"` : ''}
          hx-post="/bookmark/${entry.id}"
          hx-target="closest li"
          hx-swap="outerHTML"
        >${saved ? 'Saved' : 'Save'}</button>
      </div>
    </li>
  `;
}

const rows = (entries: Entry[]) => (entries.length ? entries.map(row) : html`<li>Nothing here.</li>`);

const feedRow = (feed: Source) => html`
  <li>
    <a href="/feed/${feed.id}">${feed.label}</a>
    ${feed.folder ? html`<span class="muted">${feed.folder}</span>` : ''}
    ${feed.error ? html`<span class="failed">${feed.error}</span>` : ''}
  </li>
`;

// Search results are plain links: an entry goes out to its post, a feed to its page.
const resultRow = (entry: Entry) => html`
  <li>
    <div class="row">
      ${titleLink(entry)}
      ${feedAndDate(entry)}
    </div>
  </li>
`;

export function searchResults(feeds: Source[], entries: Entry[]): Html {
  if (!feeds.length && !entries.length) return html`<p>Nothing found.</p>`;
  return html`
    ${feeds.length ? html`<ol>${feeds.map(feedRow)}</ol>` : ''}
    ${entries.length ? html`<ol class="entries">${entries.map(resultRow)}</ol>` : ''}
  `;
}

export const unreadList = (entries: Entry[], newest: number) =>
  entries.length
    ? html`
        <ol class="entries">${rows(entries)}</ol>
        <button hx-post="/read-all/${newest}" hx-target="#unread" hx-swap="innerHTML">Mark all read</button>
      `
    : html`<p>Nothing unread.</p>`;

export const entryList = (entries: Entry[]) => html`<ol class="entries">${rows(entries)}</ol>`;
export const feedList = (feeds: Source[]) => html`<ol>${feeds.map(feedRow)}</ol>`;
export const unreadSection = (entries: Entry[], newest: number) => html`<div id="unread">${unreadList(entries, newest)}</div>`;

const LINKS = [
  ['/', 'Unread'],
  ['/all', 'All'],
  ['/archive', 'Archive'],
  ['/bookmarks', 'Bookmarks'],
  ['/feeds', 'Feeds'],
] as const;

const searchIcon = html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>`;
const closeIcon = html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>`;

const searchDialog = html`
  <dialog id="search">
    <div class="search-bar">
      <input
        type="text"
        name="q"
        placeholder="Search"
        aria-label="Search"
        autocomplete="off"
        autofocus
        hx-get="/search"
        hx-trigger="input changed delay:200ms"
        hx-target="#results"
        hx-swap="innerHTML"
        hx-sync="this:replace"
      >
      <button class="icon" commandfor="search" command="close" aria-label="Close search">${closeIcon}</button>
    </div>
    <div id="results"></div>
  </dialog>
`;

export function layout(options: { title: string; path: string; version: string; content: Html }): string {
  const { title, path, version, content } = options;
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="htmx-config" content='{"noSwap": [204, 304, "4xx", "5xx"], "defaultTimeout": 8000, "transitions": true}'>
    <title>${title}</title>
    <link rel="stylesheet" href="/style.css?v=${version}">
    <script src="/js/htmx.min.js"></script>
    <script src="/js/titles.js?v=${version}"></script>
  </head>
  <body>
    <header>
      <nav>
        ${LINKS.map(([href, label]) => html`<a href="${href}" ${href === path ? html`aria-current="page"` : ''}>${label}</a>`)}
        <a href="${path}">Refresh</a>
      </nav>
      <button class="icon" commandfor="search" command="show-modal" aria-label="Search">${searchIcon}</button>
    </header>

    <main
      hx-on:htmx:error="event.target.classList.add('failed')"
      hx-on:htmx:response:error="event.target.classList.add('failed')"
      hx-on:htmx:before:request="event.target.classList.remove('failed')"
    >
      ${content}
      ${searchDialog}
    </main>
  </body>
</html>
`.value;
}
