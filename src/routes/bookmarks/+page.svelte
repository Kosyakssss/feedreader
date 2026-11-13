<script lang="ts">
  import { resolve } from '$app/paths';
  import BookmarkCard from '#lib/components/BookmarkCard.svelte';
  import Card from '#lib/components/Card.svelte';
  import MoreButton from '#lib/components/MoreButton.svelte';
  import EntryList from '#lib/components/EntryList.svelte';
  import ListActions from '#lib/components/ListActions.svelte';
  import { Selection } from '#lib/selection.svelte.ts';
  import LinkField from '#lib/components/LinkField.svelte';
  import { library } from '#lib/library.svelte.ts';
  import type { Entry } from '#lib/server/store.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  // Taking the bookmark off takes the entry off this page.
  const entries = $derived(library.list(data.list?.entries, library.bookmarks));
  const selection = new Selection(() => entries);

  async function bookmark(text: string) {
    const response = await fetch(resolve('/api/bookmarks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) return { message: 'Could not save those.', failed: true };
    const { entries: added }: { entries: Entry[] } = await response.json();
    if (!added.length) return { message: 'No links in that.', failed: true };
    library.put(added);
    return { message: added.length === 1 ? 'Bookmarked.' : `Bookmarked ${added.length}.` };
  }
</script>

<svelte:head><title>Bookmarks</title></svelte:head>

<LinkField placeholder="Paste links to bookmark" send={bookmark} />
<EntryList {entries} toggles={['read']} {selection}>
  {#snippet extra(entry)}
    <MoreButton key="e{entry.id}" />
  {/snippet}
  {#snippet card(entry)}
    <Card key="e{entry.id}"><BookmarkCard {entry} onremove={() => library.toggle(entry, 'bookmark')} /></Card>
  {/snippet}
</EntryList>
{#if entries.length}<ListActions {selection} />{/if}
