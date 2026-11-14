<script lang="ts">
  import { afterNavigate } from '$app/navigation';
  import { refitTitles } from '#lib/fit-title.ts';
  import type { Toggle } from '#lib/library.svelte.ts';
  import { Selection } from '#lib/selection.svelte.ts';
  import type { Entry } from '#lib/server/store.ts';
  import type { Snippet } from 'svelte';
  import ListActions from './ListActions.svelte';
  import Row from './Row.svelte';

  // A page's list of entries, with its buttons for choosing several. `end`
  // is the page's own button, at the right, and `words` what it may say.
  let {
    entries,
    toggles = ['read', 'bookmark'],
    extra,
    card,
    empty = 'Nothing here.',
    end,
    words,
  }: {
    entries: Entry[];
    toggles?: Toggle[];
    extra?: Snippet<[Entry]>;
    card?: Snippet<[Entry]>;
    empty?: string;
    end?: Snippet;
    words?: string[];
  } = $props();

  const selection = new Selection(() => entries);

  // Another page, or another feed on this one, starts unchosen.
  afterNavigate(() => selection.stop());

  // Rows that leave, read or bookmarked elsewhere, leave the choice too; and
  // with nothing left to choose from, choosing ends.
  $effect(() => {
    selection.keep(entries);
    if (!entries.length) selection.stop();
  });

  // The boxes take room from the titles.
  $effect(() => {
    void selection.choosing;
    refitTitles();
  });

  // Escape closes a popup first, if one is open; the layout says so.
  function keydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !selection.choosing || event.defaultPrevented) return;
    selection.stop();
    event.preventDefault();
  }
</script>

<svelte:document
  onkeydown={keydown}
  onpointermove={(event) => selection.move(event)}
  onpointerup={(event) => selection.up(event)}
  onpointercancel={(event) => selection.up(event)}
/>

<!-- Always there, even empty, so the last row to leave still plays its going. -->
<ol class="entries" class:choosing={selection.choosing}>
  {#each entries as entry (entry.id)}
    <Row {entry} {toggles} {extra} {card} {selection} />
  {/each}
</ol>
{#if entries.length}
  <ListActions {selection} {end} {words} />
{:else}
  <p>{empty}</p>
{/if}
