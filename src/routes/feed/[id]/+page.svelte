<script lang="ts">
  import EntryList from '#lib/components/EntryList.svelte';
  import { library } from '#lib/library.svelte.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const entries = $derived(library.list(data.list?.entries, library.feed(data.id)));
  const label = $derived(library.source(data.id)?.label ?? data.list?.label);
</script>

<svelte:head><title>{label}</title></svelte:head>

<EntryList {entries} />
