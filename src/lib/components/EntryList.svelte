<script lang="ts">
  import type { Rows, Toggle } from '#lib/rows.svelte.ts';
  import type { Entry } from '#lib/server/store.ts';
  import type { Snippet } from 'svelte';
  import Row from './Row.svelte';

  let {
    rows,
    toggles = ['read', 'bookmark'],
    extra,
    empty = 'Nothing here.',
  }: { rows: Rows; toggles?: Toggle[]; extra?: Snippet<[Entry]>; empty?: string } = $props();
</script>

{#if rows.list.length}
  <ol class="entries">
    {#each rows.list as entry (entry.id)}
      <Row
        {entry}
        {toggles}
        failed={(toggle) => rows.failed.has(`${entry.id} ${toggle}`)}
        ontoggle={(toggle) => rows.toggle(entry, toggle)}
        {extra}
      />
    {/each}
  </ol>
{:else}
  <p>{empty}</p>
{/if}
