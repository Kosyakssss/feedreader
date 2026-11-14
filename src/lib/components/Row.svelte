<script lang="ts">
  import { fitTitle } from '#lib/fit-title.ts';
  import { depart, enter } from '#lib/leave.ts';
  import { resolve } from '$app/paths';
  import { capTitle, dateLabel, displayTitle } from '#lib/format.ts';
  import { library, type Toggle } from '#lib/library.svelte.ts';
  import type { Selection } from '#lib/selection.svelte.ts';
  import type { Entry } from '#lib/server/store.ts';
  import type { Snippet } from 'svelte';

  // Without `toggles` the row is a plain link, as in search results. Otherwise
  // it is a line of a ledger: the title, and below it the feed and the date,
  // dots leading across to the row's buttons. `extra` is any more buttons
  // after them, and `card` what opens below the row.
  let {
    entry,
    toggles = [],
    extra,
    card,
    selection,
  }: {
    entry: Entry;
    toggles?: Toggle[];
    extra?: Snippet<[Entry]>;
    card?: Snippet<[Entry]>;
    selection?: Selection;
  } = $props();

  const title = $derived(capTitle(displayTitle(entry)));
  const source = $derived(entry.page ? new URL(entry.url).hostname.replace(/^www\./, '') : entry.feed);
  const listed = $derived(toggles.length > 0 || extra !== undefined);
  const choosing = $derived(selection?.choosing ?? false);
  const chosen = $derived(selection?.ids.has(entry.id) ?? false);
  const failed = (toggle: Toggle) => library.failed.has(`${entry.id} ${toggle}`);

  // Opening reads it. A plain click follows the link in this tab; with a
  // modifier key, or the middle button, it opens in another.
  function opened(event: MouseEvent): void {
    if (choosing) return; // the row takes it
    if (!listed || event.defaultPrevented || event.button > 1) return;
    const away = event.button === 0 && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
    library.open([entry], away);
  }

  // While choosing, the whole row is the box.
  function pressed(event: MouseEvent): void {
    if (!choosing || (event.target as Element).closest('.check, .card')) return;
    event.preventDefault(); // its links go nowhere
    selection!.press(event, entry.id);
  }
</script>

<li data-id={entry.id} in:enter out:depart={() => entry}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions: the box is the row's control, this only widens it -->
  <div
    class="row"
    class:read={entry.state === 'read'}
    class:chosen
    onclick={pressed}
    onpointerdown={(event) => selection?.down(event, entry.id)}
  >
    {#if selection}
      <label class="check" inert={!choosing}>
        <input
          type="checkbox"
          checked={chosen}
          aria-label="Choose {title}"
          onclick={(event) => selection.press(event, entry.id)}
        />
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 8.4 6.9 11 11.8 5.2" pathLength="1" /></svg>
      </label>
    {/if}
    <a
      class="title"
      href={entry.url}
      rel="noopener"
      onclick={opened}
      onauxclick={opened}
      draggable={choosing ? 'false' : undefined}
      {@attach fitTitle(title)}>{title}</a
    >
    <div class="meta">
      <small>
        <span class="source">
          {#if entry.page}{source}{:else}<a
              href={resolve('/(app)/feed/[id]', { id: String(entry.source_id) })}
              draggable={choosing ? 'false' : undefined}>{source}</a
            >{/if}
        </span>
        <span class="date">{dateLabel(entry.published_at)}</span>
      </small>
      {#if listed}
        <span class="leaders" aria-hidden="true"></span>
        <span class="row-buttons" inert={choosing}>
          {#if toggles.includes('read')}
            <button
              class="mark read"
              class:on={entry.state === 'read'}
              class:failed={failed('read')}
              aria-pressed={entry.state === 'read'}
              aria-label="Read"
              title={entry.state === 'read' ? 'Mark unread' : 'Mark read'}
              onclick={() => library.toggle(entry, 'read')}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.6 8.6 6.6 11.4 12.4 4.8" /></svg>
            </button>
          {/if}
          {#if toggles.includes('bookmark')}
            <button
              class="mark bookmark"
              class:on={entry.bookmarked}
              class:failed={failed('bookmark')}
              aria-pressed={entry.bookmarked === 1}
              aria-label="Bookmark"
              title={entry.bookmarked ? 'Remove bookmark' : 'Bookmark'}
              onclick={() => library.toggle(entry, 'bookmark')}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.75 2.75h6.5v10.5L8 10.9l-3.25 2.35z" /></svg>
            </button>
          {/if}
          {@render extra?.(entry)}
        </span>
      {/if}
    </div>
    {@render card?.(entry)}
  </div>
</li>
