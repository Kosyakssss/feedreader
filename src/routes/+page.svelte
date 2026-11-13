<script lang="ts">
  import { MediaQuery } from 'svelte/reactivity';
  import Actions from '#lib/components/Actions.svelte';
  import EntryList from '#lib/components/EntryList.svelte';
  import { library } from '#lib/library.svelte.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  // Marking an entry read takes it off Unread.
  const entries = $derived(library.list(data.list?.entries, library.unread));

  // A phone opens one tab per press, so there it opens the next entry instead
  // of all of them. Opening never marks anything read.
  const touch = new MediaQuery('pointer: coarse');
  let opened = $state<number>(); // the last entry opened, by either button or its title

  function openAll(): void {
    for (const entry of entries.toReversed()) window.open(entry.url, '_blank', 'noopener');
  }

  function openNext(): void {
    const next = entries[entries.findIndex((entry) => entry.id === opened) + 1] ?? entries[0];
    if (!next) return;
    opened = next.id;
    window.open(next.url, '_blank', 'noopener');
  }
</script>

<svelte:head><title>Lagan</title></svelte:head>

{#if entries.length}
  <EntryList {entries} marked={opened} onopen={(entry) => (opened = entry.id)} />
  <Actions>
    {#snippet start()}
      <button class:failed={library.readAllFailed} onclick={() => library.readAll(entries)}>Mark all read</button>
    {/snippet}
    {#snippet end()}
      {#if touch.current}
        <button onclick={openNext}>Open next</button>
      {:else}
        <button onclick={openAll}>Open all</button>
      {/if}
    {/snippet}
  </Actions>
{:else}
  <p>Nothing unread.</p>
{/if}
