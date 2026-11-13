<script lang="ts">
  import type { Snippet } from 'svelte';

  // A page's own buttons, in the bottom corners over the list. `words` is
  // every label either may show: each pill holds them all, unseen, so the two
  // are one width, the width of the widest, whatever they say at the moment.
  let { start, end, words = [] }: { start?: Snippet; end?: Snippet; words?: string[] } = $props();
</script>

{#snippet sizer()}
  <span class="sizer" aria-hidden="true"
    >{#each words as word (word)}<span>{word}</span>{/each}</span
  >
{/snippet}

<div class="actions">
  {#if start}
    <div class="action start">{@render sizer()}{@render start()}</div>
  {/if}
  {#if end}
    <div class="action end">{@render sizer()}{@render end()}</div>
  {/if}
</div>
