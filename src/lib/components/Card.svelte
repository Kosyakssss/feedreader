<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cards } from '#lib/cards.svelte.ts';

  // What a row's More button opens below the row. What is inside is made the
  // first time it opens and kept, so closing can animate it away.
  let { key, children }: { key: string; children: Snippet } = $props();

  const open = $derived(cards.isOpen(key));
  let opened = $state(false);
  $effect(() => {
    if (open) opened = true;
  });
</script>

<div class="card" class:open inert={!open}>
  <div>
    {#if opened}{@render children()}{/if}
  </div>
</div>
