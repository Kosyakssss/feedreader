<script lang="ts">
  import { library, type Toggle } from '#lib/library.svelte.ts';
  import type { Entry } from '#lib/server/store.ts';
  import type { Snippet } from 'svelte';
  import Row from './Row.svelte';

  let {
    entries,
    toggles = ['read', 'bookmark'],
    extra,
    card,
    empty = 'Nothing here.',
    marked,
    onopen,
  }: {
    entries: Entry[];
    toggles?: Toggle[];
    extra?: Snippet<[Entry]>;
    card?: Snippet<[Entry]>;
    empty?: string;
    marked?: number; // the entry to show as where you are
    onopen?: (entry: Entry) => void;
  } = $props();
</script>

{#if entries.length}
  <ol class="entries">
    {#each entries as entry (entry.id)}
      <Row
        {entry}
        {toggles}
        failed={(toggle) => library.failed.has(`${entry.id} ${toggle}`)}
        ontoggle={(toggle) => library.toggle(entry, toggle)}
        {extra}
        {card}
        marked={entry.id === marked}
        onopen={onopen && (() => onopen(entry))}
      />
    {/each}
  </ol>
{:else}
  <p>{empty}</p>
{/if}
