<script lang="ts">
  import { symbols, type IconName } from '$lib/icons';
  let { name, class: className = 'ui-icon' }: { name: IconName; class?: string } = $props();
</script>

<svg class={className} viewBox="0 0 20 20" aria-hidden="true" focusable="false"
  ><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
    >{@html symbols[name]}</g
  ></svg
>
