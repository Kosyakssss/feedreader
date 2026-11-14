// Every page, as HTML. Each one is whole by itself, its CSS inside it. htmx,
// cached after the first page, saves a few things from reloading the page:
// keep, stopping following, search as it is typed, and importing a file.
// Each still works as a plain link or form without it.
import { displayTitle } from '#lib/format.ts';
import { html, raw, type Html, type Part } from '#lib/html.ts';
import type { Entry, Source } from '#lib/server/store.ts';

export type Counts = { kept: number; feeds: number };

const css = await Bun.file(new URL('./style.css', import.meta.url)).text();

// Where a change says how it went. Always there, empty or not, for htmx to fill.
const said = (text: string | null) => html`<p id="said" class="note">${text}</p>`;

// The pages of an app served under `base`, with htmx at `htmx`.
export function pages(base: string, htmx: string) {
  const at = (path: string) => base + path;

  // Links within the app are fetched ahead, those in the header as soon as
  // the page is up, the rest as they are about to be pressed. (Chrome only;
  // other browsers ignore it.) The feeds file is a download, not a page.
  const speculation = JSON.stringify({
    prefetch: [
      { where: { selector_matches: 'header a' }, eagerness: 'eager' },
      {
        where: { and: [{ href_matches: at('/*') }, { not: { href_matches: at('/opml') } }] },
        eagerness: 'moderate',
      },
    ],
  });

  // In the header, and sent again by htmx whenever keep changes it.
  const keptCount = (counts: Counts, here = '', again = false) =>
    html`<a
      id="kept-count"
      href="${at('/kept')}"
      ${here === '/kept' && html`aria-current="page"`}
      ${again && html`hx-swap-oob="true"`}
      >${counts.kept} kept</a
    >`;

  function page(title: string, counts: Counts, body: Part, here = ''): Html {
    const link = (path: string, words: Part) =>
      html`<a href="${at(path)}" ${here === path && html`aria-current="page"`}>${words}</a>`;
    return html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
          <meta name="color-scheme" content="dark" />
          <meta name="theme-color" content="#205ea6" />
          <title>${title}</title>
          <style>
            ${raw(css)}
          </style>
          <script src="${htmx}" defer></script>
          <script type="speculationrules">
            ${raw(speculation)}
          </script>
        </head>
        <body ontouchstart="">
          <header>
            <p class="name">${link('/', 'Lagan.')}</p>
            <p class="intro">
              ${keptCount(counts, here)} for later, from ${link('/feeds', `${counts.feeds} feeds`)}.
              ${link('/search', 'Search')} or ${link('/settings', 'settings')}.
            </p>
          </header>
          <main>${body}</main>
        </body>
      </html>`;
  }

  // Keep, or kept: a form that works as one, and that htmx sends without
  // leaving the page, swapping in the answer, the same form turned over.
  // Turned over just now, it says so.
  function keep(entry: Entry, fresh = false): Html {
    const kept = entry.bookmarked === 1;
    return html`<form
      class="keep ${fresh && 'fresh'}"
      method="post"
      action="${at('/keep')}"
      hx-post="${at('/keep')}"
      hx-swap="outerHTML"
    >
      <input type="hidden" name="id" value="${entry.id}" /><input type="hidden" name="keep" value="${kept ? 0 : 1}" />
      <button aria-pressed="${String(kept)}">${kept ? 'kept' : 'keep'}</button>
    </form>`;
  }

  const entries = (list: Entry[], empty: string) =>
    list.length
      ? html`<ol class="entries">
          ${list.map(
            (entry) =>
              html`<li id="e${entry.id}">
                <a href="${entry.url}">${displayTitle(entry)}</a>
                <div class="meta">
                  <a class="from" href="${at(`/feed/${entry.source_id}`)}">${entry.feed}</a>${keep(entry)}
                </div>
              </li>`,
          )}
        </ol>`
      : html`<p>${empty}</p>`;

  // One line to type or paste into, sent with Enter or its button.
  const field = (action: string, name: string, placeholder: string, button: string, value = '') =>
    html`<form class="field" method="post" action="${at(action)}">
      <input
        name="${name}"
        value="${value}"
        placeholder="${placeholder}"
        aria-label="${placeholder}"
        required
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        enterkeyhint="go"
      />
      <button>${button}</button>
    </form>`;

  // A feed's own setting: what it is, and a line to change it.
  const setting = (source: Source, name: string, label: string, placeholder: string, words: string[]) =>
    html`<label class="label" for="${name}">${label}</label>
      <form class="field" method="post" action="${at(`/feed/${source.id}/${name}`)}">
        <input
          id="${name}"
          name="${name}"
          value="${words.join(', ')}"
          placeholder="${placeholder}"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
        />
        <button>Save</button>
      </form>`;

  // Stopping following asks once more. htmx swaps the question in place;
  // without it, the question is the page again.
  function stop(source: Source, sure: boolean): Html {
    const swap = (query: string) =>
      html`hx-get="${at(`/feed/${source.id}/stop${query}`)}" hx-target="#stop" hx-swap="outerHTML"`;
    if (!sure)
      return html`<div id="stop" class="stop">
        <a class="button" href="${at(`/feed/${source.id}`)}?stop" ${swap('?sure')}>Stop following</a>
      </div>`;
    return html`<div id="stop" class="stop sure">
      <span>Sure?</span>
      <form method="post" action="${at(`/feed/${source.id}/remove`)}">
        <button class="filled">Stop following</button>
      </form>
      <a href="${at(`/feed/${source.id}`)}" ${swap('')}>Cancel</a>
    </div>`;
  }

  // What search found: feeds by name, then entries by title.
  const found = (query: string, feeds: Source[], list: Entry[]) =>
    query &&
    html`${
      feeds.length > 0 &&
      html`<ul class="feeds">
        ${feeds.map((feed) => html`<li><a href="${at(`/feed/${feed.id}`)}">${feed.label}</a></li>`)}
      </ul>`
    }${entries(list, 'Nothing found.')}`;

  return {
    keep,
    keptCount,
    stop,
    found,
    said,

    home: (counts: Counts, list: Entry[]) => page('Lagan', counts, entries(list, 'Nothing yet.'), '/'),

    kept: (counts: Counts, list: Entry[], note: string | null) =>
      page(
        'Kept',
        counts,
        html`${field('/kept', 'links', 'Paste links to keep', 'Keep')}${said(note)}${entries(list, 'Nothing kept.')}`,
        '/kept',
      ),

    feeds: (counts: Counts, sources: Source[], note: string | null, typed: string) =>
      page(
        'Feeds',
        counts,
        html`${field('/feeds', 'url', 'Feeds, sites or @handles', 'Follow', typed)}${said(note)}
          <ul class="feeds">
            ${sources.map(
              (source) =>
                html`<li>
                  <a href="${at(`/feed/${source.id}`)}">${source.label}</a
                  >${source.folder && html` <span>${source.folder}</span>`}${source.error && html` <span>failing</span>`}
                </li>`,
            )}
          </ul>`,
        '/feeds',
      ),

    // A feed, or a site whose pages were kept.
    feed: (counts: Counts, source: Source, mutes: string[], cuts: string[], list: Entry[], stopping: boolean) =>
      page(
        source.label,
        counts,
        html`<h1>${source.label}</h1>
          ${
            source.kind === 'page'
              ? html`<p class="address"><a href="https://${source.ref}/">Open the site</a></p>`
              : html`<p class="address">${source.ref}</p>`
          }
          ${source.error && html`<p class="note">Failing: ${source.error}</p>`}
          ${setting(source, 'mutes', 'Hide entries whose titles have', 'Words, with commas', mutes)}
          ${setting(source, 'cuts', 'Take out of every title', 'Such as - YouTube', cuts)}
          ${source.kind !== 'page' && stop(source, stopping)} ${entries(list, 'Nothing here yet.')}`,
      ),

    search: (counts: Counts, query: string, feeds: Source[], list: Entry[]) =>
      page(
        query ? `${query} – Search` : 'Search',
        counts,
        html`<form
            class="field"
            action="${at('/search')}"
            hx-get="${at('/search')}"
            hx-target="#results"
            hx-replace-url="true"
          >
            <input
              type="search"
              name="q"
              value="${query}"
              placeholder="Feeds and titles"
              aria-label="Search"
              ${!query && html`autofocus`}
              autocomplete="off"
              enterkeyhint="search"
              hx-get="${at('/search')}"
              hx-trigger="input changed delay:150ms"
            />
            <button>Search</button>
          </form>
          <div id="results">${found(query, feeds, list)}</div>`,
        '/search',
      ),

    settings: (counts: Counts, note: string | null) =>
      page(
        'Settings',
        counts,
        html`<h1>Feeds file</h1>
          <p>OPML, the list of feeds other readers import and export.</p>
          <form
            class="buttons"
            method="post"
            action="${at('/opml')}"
            enctype="multipart/form-data"
            hx-post="${at('/opml')}"
            hx-encoding="multipart/form-data"
            hx-trigger="change"
            hx-target="#said"
            hx-swap="outerHTML"
          >
            <a class="button" href="${at('/opml')}" download="lagan.opml">Export</a>
            <label class="button"
              >Import<input type="file" name="file" accept=".opml,.xml,text/xml,text/x-opml" required hidden
            /></label>
            <noscript><button>Send the file</button></noscript>
          </form>
          ${said(note)}`,
        '/settings',
      ),

    missing: (counts: Counts) => page('Not found', counts, html`<p>Nothing here.</p>`),
  };
}

export type Pages = ReturnType<typeof pages>;
