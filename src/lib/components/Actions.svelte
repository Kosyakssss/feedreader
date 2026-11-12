<script lang="ts">
  import type { Snippet } from 'svelte';
  import { wash } from '#lib/wash.ts';

  // A page's own buttons, in the bottom corners over the list.
  let { start, end }: { start?: Snippet; end?: Snippet } = $props();
</script>

<div class="actions">
  {#if start}<div class="action start" {@attach wash('start')}>{@render start()}</div>{/if}
  {#if end}<div class="action end" {@attach wash('end')}>{@render end()}</div>{/if}
</div>
