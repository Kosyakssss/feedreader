// What every page looks like.
import { displayTitle, type Entry, type Source } from './store';

export class Html {
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

export const feedPath = (id: number) => `/feed/${id}`;

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
const feedAndDate = (entry: Entry) => html`<small><a href="${feedPath(entry.source_id)}">${entry.feed}</a> ${dateLabel(entry.published_at)}</small>`;

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
    <a href="${feedPath(feed.id)}">${feed.label}</a>
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

export const entryList = (entries: Entry[]) => html`<ol class="entries">${rows(entries)}</ol>`;
export const feedList = (feeds: Source[]) => html`<ol>${feeds.map(feedRow)}</ol>`;

export function searchResults(feeds: Source[], entries: Entry[]): Html {
  if (!feeds.length && !entries.length) return html`<p>Nothing found.</p>`;
  return html`
    ${feeds.length ? feedList(feeds) : ''}
    ${entries.length ? html`<ol class="entries">${entries.map(resultRow)}</ol>` : ''}
  `;
}

export const unreadSection = (entries: Entry[], newest: number) => html`
  <div id="unread">
    ${entries.length
      ? html`
          ${entryList(entries)}
          <button hx-post="/read-all/${newest}" hx-target="#unread" hx-swap="innerHTML">Mark all read</button>
        `
      : html`<p>Nothing unread.</p>`}
  </div>
`;

const APP_NAME = 'Lagan';

type Link = { href: string; label: string };
type Crumb = Link & { under?: Link[] };

const FEEDS: Link = { href: '/feeds', label: 'Feeds' };
const PAGES: Link[] = [{ href: '/all', label: 'All' }, { href: '/archive', label: 'Archive' }, { href: '/bookmarks', label: 'Bookmarks' }, FEEDS];

// Where a page sits. A crumb's `under` is the list of pages below it.
function trailFor(path: string, feeds: Source[]): Crumb[] {
  const home: Crumb = { href: '/', label: APP_NAME, under: PAGES };
  const feedsPage: Crumb = { ...FEEDS, under: feeds.map((feed) => ({ href: feedPath(feed.id), label: feed.label })) };
  if (path === '/') return [home];
  if (path === FEEDS.href) return [home, feedsPage];
  const page = PAGES.find((link) => link.href === path);
  if (page) return [home, page];
  return [home, feedsPage, { href: path, label: feeds.find((feed) => feedPath(feed.id) === path)?.label ?? '' }];
}

function menuPopover(id: string, links: Link[], trail: Crumb[]): Html {
  return html`
    <div class="menu" id="${id}" popover="manual">
      <div class="menu-list">
        ${links.map(
          (link) => html`<a href="${link.href}" ${trail.some((step) => step.href === link.href) ? html`aria-current="page"` : ''}>${link.label}${link === FEEDS ? '/' : ''}</a>`,
        )}
      </div>
    </div>
  `;
}

// Pressing a name opens or closes what is under it. While the menu is still
// animating, the link on top of the name takes a second press to that page.
// A name with nothing under it is just text.
function crumb(step: Crumb, index: number, trail: Crumb[]): Html {
  const current = index === trail.length - 1 ? html`aria-current="page"` : '';
  if (!step.under) return html`<span class="crumb" ${current}>${step.label}</span>`;
  const menu = `menu-${index}`;
  return html`
    <div class="crumb" ${current}>
      <button popovertarget="${menu}">${step.label}<span class="slash"></span></button>
      <a class="press-again" href="${step.href}" tabindex="-1" aria-hidden="true"></a>
      ${menuPopover(menu, step.under, trail)}
    </div>
  `;
}

const searchIcon = html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="lens" cx="11" cy="11" r="7" /><path class="handle" d="M6 6L20 20" pathLength="1" /></svg>`;

const searchPopover = html`
  <div id="search" popover="manual">
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
        hx-swap="innerHTML transition:false"
        hx-sync="this:replace"
      >
      <button class="icon" popovertarget="search" popovertargetaction="hide" aria-label="Close search">${searchIcon}</button>
    </div>
    <div id="results"></div>
  </div>
`;

export function layout(options: { title: string; path: string; version: string; content: Html; feeds: Source[] }): string {
  const { title, path, version, content, feeds } = options;
  const trail = trailFor(path, feeds);
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="htmx-config" content='{"noSwap": [204, 304, "4xx", "5xx"], "defaultTimeout": 8000, "transitions": true}'>
    <title>${title}</title>
    <link rel="stylesheet" href="/style.css?v=${version}">
    <script src="/js/htmx.min.js"></script>
    <script src="/js/main.js?v=${version}"></script>
  </head>
  <body>
    <div class="header-glass"></div>
    <header>
      <nav>${trail.map(crumb)}</nav>
      <button class="icon" popovertarget="search" aria-label="Search">${searchIcon}</button>
    </header>

    <div class="veil"></div>

    <main
      hx-on:htmx:error="event.target.classList.add('failed')"
      hx-on:htmx:response:error="event.target.classList.add('failed')"
      hx-on:htmx:before:request="event.target.classList.remove('failed')"
    >
      ${content}
      ${searchPopover}
    </main>
  </body>
</html>
`.value;
}
