// Every page, as HTML. Each one is whole by itself, its CSS inside it. htmx,
// cached after the first page, saves a few things from reloading the page:
// keep, editing a feed's name, stopping following, and search as it is typed. Each still works as a plain link or form without it.
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

const css = await Bun.file(new URL('./style.css', import.meta.url)).text();

// Where a change says how it went.
const said = (text: string | null) => text && html`<p class="note">${text}</p>`;

// An address as people write it.
const shown = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

// Where a feed lives on the web: its site, or a Bluesky account's profile.
function home(source: Source): string {
  if (source.kind === 'atproto') return `https://bsky.app/profile/${source.ref}`;
  if (source.kind === 'page') return `https://${source.ref}/`;
  return `${URL.parse(source.ref)?.origin ?? source.ref}/`;
}

// A feed's address as people know it: a Bluesky account's profile rather
// than its DID.
export const address = (source: Source) =>
  source.kind === 'atproto' ? `https://bsky.app/profile/${source.ref}` : source.ref;

// The pages of an app served under `base`, with htmx at `htmx`.
export function pages(base: string, htmx: string) {
  const at = (path: string) => base + path;
  const feedAt = (source: Source, rest = '') => at(`/feed/${source.id}${rest}`);
  // An htmx request for part of a page, swapped in for the element `target`.
  const swap = (path: string, target: string) => html`hx-get="${at(path)}" hx-target="#${target}" hx-swap="outerHTML"`;

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

  // Entries, each with where it is from, unless they are all from one place.
  const entries = (list: Entry[], empty: string, from = true) =>
    list.length
      ? html`<ol class="entries">
          ${list.map(
            (entry) =>
              html`<li id="e${entry.id}">
                <a href="${entry.url}">${displayTitle(entry)}</a>
                <div class="meta">
                  ${from && html`<a class="from" href="${at(`/feed/${entry.source_id}`)}">${entry.feed}</a>`}${keep(entry)}
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

  // A feed's own setting: what it is, and a line to change it.
  const setting = (source: Source, name: string, label: string, words: string[]) =>
    html`<label class="label" for="${name}">${label}</label>
      <form class="field" method="post" action="${feedAt(source, `/${name}`)}">
        <input
          id="${name}"
          name="${name}"
          value="${words.join(', ')}"
          placeholder="With commas between"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
        />
        <button>Save</button>
      </form>`;

  // A feed's name, a link to its site, with Edit at its end.
  const name = (source: Source) =>
    html`<div id="name" class="title">
      <h1><a href="${home(source)}">${source.label}</a></h1>
      <a class="button" href="${feedAt(source, '?edit')}" ${swap(`/feed/${source.id}/edit`, 'name')}>Edit</a>
    </div>`;

  // Editing a feed's name and address, in place of the name; after a try
  // that failed, with what was typed and why.
  const edit = (source: Source, note: string | null = null, typed: { label?: string; ref?: string } = {}) =>
    html`<form id="name" class="edit" method="post" action="${feedAt(source, '/edit')}">
      <label class="label" for="label">Name</label>
      <input id="label" name="label" value="${typed.label ?? source.label}" required autocomplete="off" />
      <label class="label" for="ref">Feed address</label>
      <input
        id="ref"
        name="ref"
        value="${typed.ref ?? address(source)}"
        required
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
      />
      ${said(note)}
      <div class="buttons">
        <button class="filled">Save</button>
        <a class="button" href="${feedAt(source)}" ${swap(`/feed/${source.id}/name`, 'name')}>Cancel</a>
      </div>
    </form>`;

  // Stopping following asks once more. htmx swaps the question in place;
  // without it, the question is the page again.
  const stop = (source: Source, sure: boolean) =>
    sure
      ? html`<div id="stop" class="buttons stop sure">
          <form method="post" action="${feedAt(source, '/remove')}">
            <button class="filled">Stop following</button>
          </form>
          <a class="button" href="${feedAt(source)}" ${swap(`/feed/${source.id}/stop`, 'stop')}>Cancel</a>
        </div>`
      : html`<div id="stop" class="buttons stop">
          <a class="button" href="${feedAt(source, '?stop')}" ${swap(`/feed/${source.id}/stop?sure`, 'stop')}
            >Stop following</a
          >
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
    name,
    edit,
    stop,
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
          <ul class="feeds">
            ${sources.map(
              (source) =>
                html`<li>
                  <a href="${feedAt(source)}">${source.label}</a>${source.error && html` <span>failing</span>`}
                </li>`,
            )}
          </ul>
          <form class="buttons" method="post" action="${at('/opml')}" enctype="multipart/form-data">
            <a class="button" href="${at('/opml')}" download="lagan.opml">Export as OPML</a>
            <label class="button"
              >Import OPML<input
                type="file"
                name="file"
                accept=".opml,.xml,text/xml,text/x-opml"
                hidden
                onchange="this.form.submit()"
            /></label>
            <noscript><button>Send the file</button></noscript>
          </form>`,
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

    // A feed: its name and settings, then what it has posted.
    feed: (
      counts: Counts,
      source: Source,
      settings: { mutes: string[]; cuts: string[] },
      list: Entry[],
      ask: { edit: boolean; stop: boolean; note: string | null; typed: { label?: string; ref?: string } },
    ) =>
      page(
        source.label,
        counts,
        html`${ask.edit ? edit(source, ask.note, ask.typed) : name(source)}
        ${source.error && html`<p class="note">Failing: ${source.error}</p>`}
        ${setting(source, 'mutes', 'Hide entries whose titles have any of', settings.mutes)}
        ${setting(source, 'cuts', 'Take out of every title, wherever they appear', settings.cuts)}
        ${stop(source, ask.stop)} ${entries(list, 'Nothing here yet.', false)}`,
      ),

    // A site whose pages were kept from their links. It isn't followed, so
    // all there is to change is how its titles read.
    site: (counts: Counts, source: Source, cuts: string[], list: Entry[]) =>
      page(
        source.label,
        counts,
        html`<div class="title">
            <h1><a href="${home(source)}">${source.label}</a></h1>
          </div>
          <p>
            Pages saved from this site by pasting their links. It isn’t a feed: to follow someone on it, paste their
            page into Feeds.
          </p>
          ${setting(source, 'cuts', 'Take out of every title, wherever they appear', cuts)}
          ${entries(list, 'Nothing saved from here.', false)}`,
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
