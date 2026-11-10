<script lang="ts">
  import { fitTitle } from '#lib/fit-title.ts';
  import { capTitle, dateLabel, displayTitle, feedPath } from '#lib/format.ts';
  import type { Toggle } from '#lib/rows.svelte.ts';
  import type { Entry } from '#lib/server/store.ts';
  import type { Snippet } from 'svelte';

  // Without `ontoggle` the row is a plain link, as in search results. `toggles`
  // are the row buttons it shows; `extra` is anything more after them.
  let {
    entry,
    toggles = [],
    failed = () => false,
    ontoggle,
    extra,
    marked = false,
    onopen,
  }: {
    entry: Entry;
    toggles?: Toggle[];
    failed?: (toggle: Toggle) => boolean;
    ontoggle?: (toggle: Toggle) => void;
    extra?: Snippet<[Entry]>;
    marked?: boolean;
    onopen?: () => void;
  } = $props();

  const title = $derived(capTitle(displayTitle(entry)));
  const source = $derived(entry.page ? new URL(entry.url).hostname.replace(/^www\./, '') : entry.feed);
</script>

<li>
  <div class="row" class:read={entry.state === 'read'} class:marked style:view-transition-name="e{entry.id}">
    <a class="title" href={entry.url} target="_blank" rel="noopener" onclick={onopen} {@attach fitTitle(title)}
      >{title}</a
    >
    <small>
      {#if entry.page}{source}{:else}<a href={feedPath(entry.source_id)}>{source}</a>{/if}
      {dateLabel(entry.published_at)}
    </small>
    {#if ontoggle}
      {#if toggles.includes('read')}
        <button class:failed={failed('read')} aria-pressed={entry.state === 'read'} onclick={() => ontoggle('read')}>
          {entry.state === 'read' ? 'Read' : 'Mark read'}
        </button>
      {/if}
      {#if toggles.includes('bookmark')}
        <button class:saved={entry.bookmarked} class:failed={failed('bookmark')} onclick={() => ontoggle('bookmark')}>
          {entry.bookmarked ? 'Saved' : 'Save'}
        </button>
      {/if}
    {/if}
    {@render extra?.(entry)}
  </div>
</li>
