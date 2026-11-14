<script lang="ts">
  import { library } from '#lib/library.svelte.ts';
  import type { Selection } from '#lib/selection.svelte.ts';
  import type { Snippet } from 'svelte';

  // A list's buttons, in the bottom corners over it. Select, on the left,
  // puts a box on every row; while choosing, the right-hand pill grows upward
  // into three: read and bookmark what is chosen, and, where the page's own
  // button was, choose everything. `end` is that button, if the page has one,
  // and `words` what it may say. Each pill holds every word either may say,
  // unseen, so the two are one width whatever they say at the moment.
  let { selection, end, words = [] }: { selection: Selection; end?: Snippet; words?: string[] } = $props();

  const chosen = $derived(selection.chosen);
  const allRead = $derived(chosen.length > 0 && chosen.every((entry) => entry.state === 'read'));
  const allBookmarked = $derived(chosen.length > 0 && chosen.every((entry) => entry.bookmarked === 1));

  // Done, choosing ends, and what was chosen goes as one.
  function mark(change: { read: boolean } | { bookmarked: boolean }): void {
    void library.mark(chosen, change);
    selection.stop();
  }
</script>

{#snippet sizer()}
  <span class="sizer" aria-hidden="true">
    {#each ['Select', 'Cancel', 'Mark read', 'Mark unread', 'Bookmark', 'Unbookmark', 'Select all', 'Select none', ...words] as word (word)}<span
        >{word}</span
      >{/each}
  </span>
{/snippet}

<div class="actions">
  <div class="action start">
    {@render sizer()}
    <button
      aria-pressed={selection.choosing}
      onclick={() => (selection.choosing ? selection.stop() : selection.start())}
    >
      {selection.choosing ? 'Cancel' : 'Select'}
    </button>
  </div>
  {#if end || selection.choosing}
    <div class="action end">{@render sizer()}{@render stack()}</div>
  {/if}
</div>

{#snippet stack()}
  <div class="stack" class:open={selection.choosing}>
    <div class="grown">
      <div inert={!selection.choosing}>
        <button disabled={!chosen.length} onclick={() => mark({ read: !allRead })}>
          {allRead ? 'Mark unread' : 'Mark read'}
        </button>
        <button disabled={!chosen.length} onclick={() => mark({ bookmarked: !allBookmarked })}>
          {allBookmarked ? 'Unbookmark' : 'Bookmark'}
        </button>
      </div>
    </div>
    {#if selection.choosing}
      <button onclick={() => selection.chooseAll()}>{selection.all ? 'Select none' : 'Select all'}</button>
    {:else}
      {@render end?.()}
    {/if}
  </div>
{/snippet}
