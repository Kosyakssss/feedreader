<script lang="ts">
  import type { Snippet } from 'svelte';

  // A page's own buttons, floating in the bottom corners over the list.
  let { start, end }: { start?: Snippet; end?: Snippet } = $props();
</script>

<div class="actions">
  <div>{@render start?.()}</div>
  <div>{@render end?.()}</div>
</div>
