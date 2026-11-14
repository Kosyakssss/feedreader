<script lang="ts">
  import { afterNavigate } from '$app/navigation';
  import { refitTitles } from '#lib/fit-title.ts';
  import type { Toggle } from '#lib/library.svelte.ts';
  import type { Selection } from '#lib/selection.svelte.ts';
  import type { Entry } from '#lib/server/store.ts';
  import type { Snippet } from 'svelte';
  import Row from './Row.svelte';

  let {
    entries,
    toggles = ['read', 'bookmark'],
    extra,
    card,
    empty = 'Nothing here.',
    selection,
  }: {
    entries: Entry[];
    toggles?: Toggle[];
    extra?: Snippet<[Entry]>;
    card?: Snippet<[Entry]>;
    empty?: string;
    selection?: Selection;
  } = $props();

  // Another page, or another feed on this one, starts unchosen.
  afterNavigate(() => selection?.stop());

  // Rows that leave, read or bookmarked elsewhere, leave the choice too; and
  // with nothing left to choose from, choosing ends.
  $effect(() => {
    if (!selection) return;
    selection.keep(entries);
    if (!entries.length) selection.stop();
  });

  // The boxes take room from the titles.
  $effect(() => {
    void selection?.choosing;
    refitTitles();
  });

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && selection?.choosing && !document.querySelector('.popup:not(.closing)')) {
      selection.stop();
      event.preventDefault();
    }
  }
</script>

<svelte:document
  onkeydown={keydown}
  onpointermove={(event) => selection?.move(event)}
  onpointerup={(event) => selection?.up(event)}
  onpointercancel={(event) => selection?.up(event)}
/>

<!-- Always there, even empty, so the last row to leave still plays its going. -->
<ol class="entries" class:choosing={selection?.choosing}>
  {#each entries as entry (entry.id)}
    <Row {entry} {toggles} {extra} {card} {selection} />
  {/each}
</ol>
{#if !entries.length}<p>{empty}</p>{/if}
