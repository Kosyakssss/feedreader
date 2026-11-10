<script lang="ts">
  import EntryList from '#lib/components/EntryList.svelte';
  import { Rows } from '#lib/rows.svelte.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  // Taking the bookmark off takes the entry off this page.
  const rows = $derived(new Rows(data.entries, (entry) => entry.state !== 'bookmarked'));
</script>

<svelte:head><title>Bookmarks</title></svelte:head>

<EntryList {rows} />
