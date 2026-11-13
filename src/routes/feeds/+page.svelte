<script lang="ts">
  import { resolve } from '$app/paths';
  import FeedList from '#lib/components/FeedList.svelte';
  import LinkField from '#lib/components/LinkField.svelte';
  import { library } from '#lib/library.svelte.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  // A feed followed here, or anywhere, joins the list as the library hears of it.
  const sources = $derived(library.ready ? library.sources : (data.list?.sources ?? []));
  const mutes = $derived(library.ready ? library.mutes : (data.list?.mutes ?? {}));

  async function follow(text: string) {
    const response = await fetch(resolve('/api/feeds'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ url: text.trim() }),
    });
    if (!response.ok) {
      const { message } = (await response.json().catch(() => ({}))) as { message?: string };
      return { message: message ? `No feed there: ${message}` : 'No feed there.', failed: true };
    }
    const { label }: { label: string } = await response.json();
    return { message: `Following ${label}.` };
  }
</script>

<svelte:head><title>Feeds</title></svelte:head>

<LinkField placeholder="Follow a feed, a site or a @handle" send={follow} />
<FeedList feeds={sources} {mutes} />
