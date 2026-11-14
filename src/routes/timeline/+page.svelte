<script lang="ts">
  import EntryList from '#lib/components/EntryList.svelte';
  import { library, TIMELINE_STEP } from '#lib/library.svelte.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  // A step at a time, as reading goes on. Until the library is here, the
  // first step is the server's, and the next waits for it.
  let shown = $state(TIMELINE_STEP);
  const everything = $derived(library.list(data.list?.entries, library.timeline));
  const entries = $derived(everything.slice(0, shown));
  const more = $derived(library.ready ? everything.length > shown : (data.list?.more ?? false));
</script>

<svelte:head><title>Timeline</title></svelte:head>

<EntryList {entries} />
{#if more}
  <button class="more" disabled={!library.ready} onclick={() => (shown += TIMELINE_STEP)}>Show more</button>
{/if}
