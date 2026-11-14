// Every page, as HTML. Each one is whole by itself, its CSS inside it. htmx,
// cached after the first page, saves keep and search as it is typed from
// reloading the page; each still works as a plain form without it. Links
// that leave the app open in a new tab.
import { displayTitle } from '#lib/format.ts';
import { html, raw, type Html, type Part } from '#lib/html.ts';
import type { Entry, Source } from '#lib/server/store.ts';

export type Counts = { kept: number; feeds: number };

// A feed found at what was typed, to look over before following it, or why
// nothing was, or the feed already followed there.
export type Found =
  | { typed: string; kind: Source['kind']; ref: string; label: string }
  | { typed: string; missed: string }
  | { typed: string; followed: Source };

// A feed's settings, as its edit shows them.
export type Edited = { label: string; ref: string; mutes: string; cuts: string };

const css = await Bun.file(new URL('./style.css', import.meta.url)).text();

// Where a change says how it went.
const said = (text: string | null) => text && html`<p class="note">${text}</p>`;

// An address as people write it.
const shown = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

// Where a feed lives on the web: its site, or a Bluesky account's profile.
const home = (source: Source) =>
  source.kind === 'atproto'
    ? `https://bsky.app/profile/${source.ref}`
    : `${URL.parse(source.ref)?.origin ?? source.ref}/`;

// A link out of the app.
const out = (url: string, words: Part, attributes: Part = '') =>
  html`<a href="${url}" target="_blank" ${attributes}>${words}</a>`;

// A feed's address as people know it: a Bluesky account's profile rather
// than its DID.
export const address = (source: Source) =>
  source.kind === 'atproto' ? `https://bsky.app/profile/${source.ref}` : source.ref;

// A line of a feed's edit.
const line = (name: keyof Edited, label: string, value: string, more: Part = '') =>
  html`<label class="label" for="${name}">${label}</label>
    <input
      id="${name}"
      name="${name}"
      value="${value}"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      ${more}
    />`;

// The pages of an app served under `base`, with htmx at `htmx`.
export function pages(base: string, htmx: string) {
  const at = (path: string) => base + path;
  const feedAt = (source: Source, rest = '') => at(`/feed/${source.id}${rest}`);

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
              ${link('/search', 'Search')} ${keptCount(counts, here)} and ${link('/feeds', `${counts.feeds} feeds`)}.
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
    const kept = entry.kept === 1;
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

  // Entries, each with where it is from: its feed's page, or for a page kept
  // from its link, its site.
  const entries = (list: Entry[], empty: string) =>
    list.length
      ? html`<ol class="entries">
          ${list.map(
            (entry) =>
              html`<li id="e${entry.id}">
                ${out(entry.url, displayTitle(entry))}
                <div class="meta">
                  ${
                    entry.site
                      ? out(`https://${entry.site}/`, entry.feed, html`class="from"`)
                      : html`<a class="from" href="${at(`/feed/${entry.source_id}`)}">${entry.feed}</a>`
                  }${keep(entry)}
                </div>
              </li>`,
          )}
        </ol>`
      : html`<p>${empty}</p>`;

  // One line to type or paste into, sent with Enter or its button, which
  // says it is at work while the page it asked for comes.
  const field = (
    action: string,
    method: 'get' | 'post',
    name: string,
    placeholder: string,
    button: string,
    busy: string,
  ) =>
    html`<form
      class="field"
      method="${method}"
      action="${at(action)}"
      onsubmit="this.querySelector('button').textContent = '${busy}'"
    >
      <input
        name="${name}"
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

  // A feed's name, a link to its site, with Edit at its end. Edit opens, in
  // their place, every setting of the feed: one Save for them all, then Stop
  // following, which asks once more first. After a save that failed, it is open,
  // with what was typed and why.
  const feedHead = (source: Source, typed: Edited, note: string | null) =>
    html`<div class="head ${note && 'editing'}">
      <div class="title">
        <h1>${out(home(source), source.label)}</h1>
        <button type="button" onclick="this.closest('.head').classList.add('editing')">Edit</button>
      </div>
      <div class="edit">
        <form id="edit" method="post" action="${feedAt(source, '/edit')}">
          ${line('label', 'Name', typed.label, html`required`)}
          ${line('ref', 'Feed address', typed.ref, html`required`)}
          ${line('mutes', 'Hide entries whose titles have any of', typed.mutes, html`placeholder="With commas between"`)}
          ${line('cuts', 'Take out of every title, wherever they appear', typed.cuts, html`placeholder="With commas between"`)}
        </form>
        ${said(note)}
        <div class="buttons">
          <button class="filled" form="edit">Save</button>
          <button
            type="button"
            onclick="const head = this.closest('.head'); head.classList.remove('editing'); head.querySelector('#edit').reset(); head.querySelector('.stop').classList.remove('sure')"
          >
            Cancel
          </button>
        </div>
        <form class="buttons stop" method="post" action="${feedAt(source, '/remove')}">
          <button
            onclick="if (!this.form.classList.contains('sure')) event.preventDefault(), this.form.classList.add('sure')"
          >
            Stop following
          </button>
          <button type="button" onclick="this.form.classList.remove('sure')">Cancel</button>
        </form>
        <hr />
      </div>
    </div>`;

  // What search found: feeds by name, then entries by title.
  const results = (query: string, feeds: Source[], list: Entry[]) =>
    query &&
    html`${
      feeds.length > 0 &&
      html`<ul class="feeds">
        ${feeds.map((feed) => html`<li><a href="${feedAt(feed)}">${feed.label}</a></li>`)}
      </ul>`
    }${entries(list, 'Nothing found.')}`;

  return {
    keep,
    keptCount,
    results,

    home: (counts: Counts, list: Entry[]) => page('Lagan', counts, entries(list, 'Nothing yet.'), '/'),

    kept: (counts: Counts, list: Entry[], note: string | null) =>
      page(
        'Kept',
        counts,
        html`${field('/kept', 'post', 'links', 'Paste links to keep', 'Keep', 'Keeping…')}${said(note)}${entries(
          list,
          'Nothing kept.',
        )}`,
        '/kept',
      ),

    feeds: (counts: Counts, sources: Source[], note: string | null) =>
      page(
        'Feeds',
        counts,
        html`${field('/feeds/new', 'get', 'links', 'Feeds, sites or @handles', 'Follow', 'Looking…')}${said(note)}
          <form class="buttons" method="post" action="${at('/opml')}" enctype="multipart/form-data">
            <a class="button" href="${at('/opml')}" download="lagan.opml">Export OPML</a>
            <label class="button"
              >Import OPML<input
                type="file"
                name="file"
                accept=".opml,.xml,text/xml,text/x-opml"
                hidden
                onchange="this.form.submit()"
            /></label>
          </form>
          <ul class="feeds">
            ${sources.map(
              (source) =>
                html`<li>
                  <a href="${feedAt(source)}">${source.label}</a>${source.error && html` <span>failing</span>`}
                </li>`,
            )}
          </ul>`,
        '/feeds',
      ),

    // What was found at what was pasted, to look over, rename and follow.
    review: (counts: Counts, found: Found[]) => {
      const followable = found.filter((each) => 'ref' in each);
      return page(
        'Follow',
        counts,
        html`<h1>
            ${
              followable.length === 1
                ? 'Follow this feed?'
                : followable.length
                  ? 'Follow these feeds?'
                  : found.some((each) => 'followed' in each)
                    ? 'Nothing new to follow'
                    : 'No feeds there'
            }
          </h1>
          <form method="post" action="${at('/feeds')}">
            ${found.map((each) =>
              'ref' in each
                ? html`<fieldset class="found">
                    <input type="hidden" name="kind" value="${each.kind}" />
                    <input type="hidden" name="found" value="${each.ref}" />
                    <label class="label"
                      >Name<input name="label" value="${each.label}" required autocomplete="off"
                    /></label>
                    <label class="label"
                      >Feed address<input
                        name="ref"
                        value="${each.ref}"
                        required
                        autocomplete="off"
                        autocapitalize="off"
                        spellcheck="false"
                    /></label>
                  </fieldset>`
                : 'missed' in each
                  ? html`<p class="note">Nothing to follow at ${shown(each.typed)}: ${each.missed}.</p>`
                  : html`<p class="note">
                      Already following <a href="${feedAt(each.followed)}">${each.followed.label}</a>.
                    </p>`,
            )}
            ${
              followable.length > 0 &&
              html`<div class="buttons">
                <button class="filled">
                  ${followable.length === 1 ? 'Follow' : `Follow all ${followable.length}`}
                </button>
              </div>`
            }
          </form>
          <p><a href="${at('/feeds')}">Back to feeds</a></p>`,
      );
    },

    // A feed: its name, its settings when editing, then what it has posted.
    feed: (counts: Counts, source: Source, list: Entry[], typed: Edited, note: string | null = null) =>
      page(
        source.label,
        counts,
        html`${feedHead(source, typed, note)}${source.error && html`<p class="note">Failing: ${source.error}</p>`}
        ${entries(list, 'Nothing here yet.')}`,
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
          <div id="results">${results(query, feeds, list)}</div>`,
        '/search',
      ),

    missing: (counts: Counts) => page('Not found', counts, html`<p>Nothing here.</p>`),
  };
}
