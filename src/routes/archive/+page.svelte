<script lang="ts">
  import EntryList from '#lib/components/EntryList.svelte';
  import { Rows } from '#lib/rows.svelte.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const rows = $derived(new Rows(data.entries));
</script>

<svelte:head><title>Archive</title></svelte:head>

<EntryList {rows} />
