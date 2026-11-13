<script lang="ts">
  import type { Snippet } from 'svelte';

  // A page's own buttons, in the bottom corners over the list. Each pill also
  // holds the other's words, unseen, so that both are as wide as the wider.
  let { start, end }: { start?: Snippet; end?: Snippet } = $props();
</script>

<div class="actions">
  {#if start}
    <div class="action start">
      {#if end}<span class="twin" aria-hidden="true" inert>{@render end()}</span>{/if}
      {@render start()}
    </div>
  {/if}
  {#if end}
    <div class="action end">
      {#if start}<span class="twin" aria-hidden="true" inert>{@render start()}</span>{/if}
      {@render end()}
    </div>
  {/if}
</div>
