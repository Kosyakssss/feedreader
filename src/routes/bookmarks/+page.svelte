<script lang="ts">
  import BookmarkCard from '#lib/components/BookmarkCard.svelte';
  import Card from '#lib/components/Card.svelte';
  import EntryList from '#lib/components/EntryList.svelte';
  import { Rows } from '#lib/rows.svelte.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  // Taking the bookmark off takes the entry off this page.
  const rows = $derived(new Rows(data.entries, (entry) => !entry.bookmarked));
</script>

<svelte:head><title>Bookmarks</title></svelte:head>

<EntryList {rows} toggles={['read']}>
  {#snippet extra(entry)}
    <Card key="e{entry.id}"><BookmarkCard {entry} onremove={() => rows.toggle(entry, 'bookmark')} /></Card>
  {/snippet}
</EntryList>
