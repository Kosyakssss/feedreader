<script lang="ts">
  import type { Rows } from '#lib/rows.svelte.ts';
  import Row from './Row.svelte';

  let { rows }: { rows: Rows } = $props();
</script>

{#if rows.list.length}
  <ol class="entries">
    {#each rows.list as entry (entry.id)}
      <Row {entry} failed={rows.failed.has(entry.id)} onbookmark={() => rows.bookmark(entry)} />
    {/each}
  </ol>
{:else}
  <p>Nothing here.</p>
{/if}
