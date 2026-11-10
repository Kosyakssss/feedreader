<script lang="ts">
  import EntryList from '#lib/components/EntryList.svelte';
  import { Rows } from '#lib/rows.svelte.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  // Saving an entry takes it off Unread.
  const rows = $derived(new Rows(data.entries, () => true));
</script>

<svelte:head><title>Lagan</title></svelte:head>

{#if rows.list.length}
  <EntryList {rows} />
  <button class:failed={rows.readAllFailed} onclick={() => rows.readAll()}>Mark all read</button>
{:else}
  <p>Nothing unread.</p>
{/if}
