<script lang="ts">
  import { MediaQuery } from 'svelte/reactivity';
  import EntryList from '#lib/components/EntryList.svelte';
  import ListActions from '#lib/components/ListActions.svelte';
  import { library } from '#lib/library.svelte.ts';
  import { Selection } from '#lib/selection.svelte.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  // Reading an entry, or bookmarking it, takes it off Unread.
  const entries = $derived(library.list(data.list?.entries, library.unread));
  const selection = new Selection(() => entries);

  // Opening reads. Newest is at the top, so what comes next is at the bottom:
  // the oldest still unread. A phone opens one tab per press, so there it
  // opens the next entry instead of all of them.
  const touch = new MediaQuery('pointer: coarse');
  const unread = $derived(entries.filter((entry) => entry.state === 'unread'));

  function openAll(): void {
    const all = unread.toReversed();
    for (const entry of all) window.open(entry.url, '_blank', 'noopener');
    library.open(all);
  }

  function openNext(): void {
    const next = unread.at(-1);
    if (!next) return;
    window.open(next.url, '_blank', 'noopener');
    library.open([next]);
  }
</script>

<svelte:head><title>Lagan</title></svelte:head>

<EntryList {entries} {selection} empty="Nothing unread." />
{#if entries.length}
  <ListActions {selection} words={['Open next', 'Open all']}>
    {#snippet end()}
      {#if touch.current}
        <button disabled={!unread.length} onclick={openNext}>Open next</button>
      {:else}
        <button disabled={!unread.length} onclick={openAll}>Open all</button>
      {/if}
    {/snippet}
  </ListActions>
{/if}
