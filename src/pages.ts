// Every page, as HTML. Each one is whole by itself: its CSS is inside it, and
// htmx, cached after the first page, only saves keep from reloading the page.
import { displayTitle } from '#lib/format.ts';
import { html, raw, type Html, type Part } from '#lib/html.ts';
import type { FoundFeed } from '#lib/server/sites.ts';
import type { Entry, Source } from '#lib/server/store.ts';

export type Counts = { kept: number; feeds: number };
export type Found = FoundFeed & { followed: number | null };

const css = await Bun.file(new URL('./style.css', import.meta.url)).text();

const note = (text: string | null) => text && html`<p class="note">${text}</p>`;

// The pages of an app served under `base`, with htmx at `htmx`.
export function pages(base: string, htmx: string) {
  const at = (path: string) => base + path;

  function page(title: string, counts: Counts, body: Part, here = ''): Html {
    const link = (path: string, words: Part) =>
      html`<a href="${at(path)}" ${here === path && html`aria-current="page"`}>${words}</a>`;
    return html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
          <meta name="color-scheme" content="light dark" />
          <meta name="theme-color" content="#4385be" media="(prefers-color-scheme: light)" />
          <meta name="theme-color" content="#205ea6" media="(prefers-color-scheme: dark)" />
          <title>${title}</title>
          <style>
            ${raw(css)}
          </style>
          <script src="${htmx}" defer></script>
        </head>
        <body>
          <header>
            ${link('/', html`<b>Lagan</b>`)}. ${link('/kept', `${counts.kept} kept`)} for later, from
            ${link('/feeds', `${counts.feeds} feeds`)}. ${link('/search', 'Search')} or
            ${link('/settings', 'settings')}.
          </header>
          <main>${body}</main>
        </body>
      </html>`;
  }

  // Keep, or kept: a form that works as one, and that htmx sends without
  // leaving the page, swapping in the answer, the same form turned over.
  function keep(entry: Entry): Html {
    const kept = entry.bookmarked === 1;
    return html`<form class="keep" method="post" action="${at('/keep')}" hx-post="${at('/keep')}" hx-swap="outerHTML">
      <input type="hidden" name="id" value="${entry.id}" /><input type="hidden" name="keep" value="${kept ? 0 : 1}" />
      <button aria-pressed="${String(kept)}">${kept ? 'kept' : 'keep'}</button>
    </form>`;
  }

  // Where an entry is from: its feed, or for a page kept from its link, its
  // site, where to look for one.
  function from(entry: Entry): Html {
    if (!entry.page) return html`<a class="from" href="${at(`/feed/${entry.source_id}`)}">${entry.feed}</a>`;
    const site = URL.parse(entry.url)?.hostname.replace(/^www\./, '') ?? entry.url;
    return html`<a class="from" href="${at('/discover')}?url=${encodeURIComponent(entry.url)}">${site}</a>`;
  }

  const entries = (list: Entry[], empty: string) =>
    list.length
      ? html`<ol class="entries">
          ${list.map(
            (entry) =>
              html`<li id="e${entry.id}">
                <a href="${entry.url}">${displayTitle(entry)}</a>
                <div class="meta">${from(entry)}${keep(entry)}</div>
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

  return {
    keep,

    home: (counts: Counts, list: Entry[]) => page('Lagan', counts, entries(list, 'Nothing yet.'), '/'),

    kept: (counts: Counts, list: Entry[], said: string | null) =>
      page(
        'Kept',
        counts,
        html`${field('/kept', 'links', 'Paste links to keep', 'Keep')}${note(said)}${entries(list, 'Nothing kept.')}`,
        '/kept',
      ),

    feeds: (counts: Counts, sources: Source[], said: string | null, typed: string) =>
      page(
        'Feeds',
        counts,
        html`${field('/feeds', 'url', 'A feed, a site or a @handle', 'Follow', typed)}${note(said)}
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

    feed: (counts: Counts, source: Source, mutes: string[], list: Entry[]) =>
      page(
        source.label,
        counts,
        html`<h1>${source.label}</h1>
          <p class="address">${source.ref}</p>
          ${source.error && html`<p class="note">Failing: ${source.error}</p>`}
          <form class="field" method="post" action="${at(`/feed/${source.id}/mutes`)}">
            <input
              name="words"
              value="${mutes.join(', ')}"
              placeholder="Muted words, with commas"
              aria-label="Muted words"
              autocomplete="off"
              autocapitalize="off"
            />
            <button>Mute</button>
          </form>
          <details class="remove">
            <summary>Stop following</summary>
            <form method="post" action="${at(`/feed/${source.id}/remove`)}">
              <button>Stop following ${source.label}</button>
            </form>
          </details>
          ${entries(list, 'Nothing from this feed yet.')}`,
      ),

    search: (counts: Counts, query: string, feeds: Source[], list: Entry[]) =>
      page(
        query ? `${query} – Search` : 'Search',
        counts,
        html`<form class="field" action="${at('/search')}">
            <input
              type="search"
              name="q"
              value="${query}"
              placeholder="Feeds and titles"
              aria-label="Search"
              ${!query && html`autofocus`}
              autocomplete="off"
              enterkeyhint="search"
            />
            <button>Search</button>
          </form>
          ${
            query &&
            feeds.length > 0 &&
            html`<ul class="feeds">
              ${feeds.map((feed) => html`<li><a href="${at(`/feed/${feed.id}`)}">${feed.label}</a></li>`)}
            </ul>`
          }
          ${query && entries(list, 'Nothing found.')}`,
        '/search',
      ),

    settings: (counts: Counts, said: string | null) =>
      page(
        'Settings',
        counts,
        html`<h1>Feeds file</h1>
          <p>
            OPML, the list of feeds other readers import and export.
            <a href="${at('/opml')}" download="lagan.opml">Export it</a>, or import one:
          </p>
          <form class="field" method="post" action="${at('/opml')}" enctype="multipart/form-data">
            <input type="file" name="file" accept=".opml,.xml,text/xml,text/x-opml" required aria-label="OPML file" />
            <button>Import</button>
          </form>
          ${note(said)}`,
        '/settings',
      ),

    // The feeds the site of a kept page offers.
    discover: (counts: Counts, site: string, found: Found[] | string) =>
      page(
        site,
        counts,
        html`<h1>Feeds on ${site}</h1>
          ${
            typeof found === 'string'
              ? html`<p class="note">Couldn’t look: ${found}</p>`
              : found.length
                ? html`<ul class="feeds">
                    ${found.map(
                      (feed) =>
                        html`<li>
                          ${
                            feed.followed
                              ? html`<a href="${at(`/feed/${feed.followed}`)}">${feed.title || site}</a>
                                  <span>followed</span>`
                              : html`<form method="post" action="${at('/feeds')}">
                                  <input type="hidden" name="url" value="${feed.url}" />${feed.title || site}
                                  <button>follow</button>
                                </form>`
                          }
                        </li>`,
                    )}
                  </ul>`
                : html`<p>None.</p>`
          }`,
      ),

    missing: (counts: Counts) => page('Not found', counts, html`<p>Nothing here.</p>`),
  };
}

export type Pages = ReturnType<typeof pages>;
