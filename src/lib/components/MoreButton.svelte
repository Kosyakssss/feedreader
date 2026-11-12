<script lang="ts">
  import { cards } from '#lib/cards.svelte.ts';

  // Opens the card with the same key below its row, or closes it.
  let { key }: { key: string } = $props();
</script>

<button class="more-button" aria-expanded={cards.isOpen(key)} onclick={() => cards.toggle(key)}>More</button>
