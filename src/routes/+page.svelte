<script lang="ts">
  import EntryList from '#lib/components/EntryList.svelte';
  import { Rows } from '#lib/rows.svelte.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  // Marking an entry read takes it off Unread.
  const rows = $derived(new Rows(data.entries, (entry) => entry.state !== 'unread'));
</script>

<svelte:head><title>Lagan</title></svelte:head>

{#if rows.list.length}
  <EntryList {rows} />
  <button class:failed={rows.readAllFailed} onclick={() => rows.readAll()}>Mark all read</button>
{:else}
  <p>Nothing unread.</p>
{/if}
