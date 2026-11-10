<script lang="ts">
  import { refreshAll } from '$app/navigation';
  import FeedList from '#lib/components/FeedList.svelte';
  import LinkField from '#lib/components/LinkField.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  async function follow(text: string) {
    const response = await fetch('/api/feeds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ url: text.trim() }),
    });
    if (!response.ok) {
      const { message } = (await response.json().catch(() => ({}))) as { message?: string };
      return { message: message ? `No feed there: ${message}` : 'No feed there.', failed: true };
    }
    const { label }: { label: string } = await response.json();
    await refreshAll();
    return { message: `Following ${label}.` };
  }
</script>

<svelte:head><title>Feeds</title></svelte:head>

<LinkField placeholder="Follow a feed, a site or a @handle" send={follow} />
<FeedList feeds={data.sources} mutes={data.mutes} />
