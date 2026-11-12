<script lang="ts">
  import BookmarkCard from '#lib/components/BookmarkCard.svelte';
  import Card from '#lib/components/Card.svelte';
  import MoreButton from '#lib/components/MoreButton.svelte';
  import EntryList from '#lib/components/EntryList.svelte';
  import LinkField from '#lib/components/LinkField.svelte';
  import { Rows } from '#lib/rows.svelte.ts';
  import type { Entry } from '#lib/server/store.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  // Taking the bookmark off takes the entry off this page.
  const rows = $derived(new Rows(data.entries, (entry) => !entry.bookmarked));

  async function bookmark(text: string) {
    const response = await fetch('/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) return { message: 'Could not save those.', failed: true };
    const { entries }: { entries: Entry[] } = await response.json();
    if (!entries.length) return { message: 'No links in that.', failed: true };
    const added = new Set(entries.map((entry) => entry.id));
    rows.list = [...entries, ...rows.list.filter((entry) => !added.has(entry.id))];
    return { message: entries.length === 1 ? 'Bookmarked.' : `Bookmarked ${entries.length}.` };
  }
</script>

<svelte:head><title>Bookmarks</title></svelte:head>

<LinkField placeholder="Paste links to bookmark" send={bookmark} />
<EntryList {rows} toggles={['read']}>
  {#snippet extra(entry)}
    <MoreButton key="e{entry.id}" />
  {/snippet}
  {#snippet card(entry)}
    <Card key="e{entry.id}"><BookmarkCard {entry} onremove={() => rows.toggle(entry, 'bookmark')} /></Card>
  {/snippet}
</EntryList>
