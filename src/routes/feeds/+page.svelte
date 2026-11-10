<script lang="ts">
  import FeedList from '#lib/components/FeedList.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<svelte:head><title>Feeds</title></svelte:head>

<FeedList feeds={data.sources} mutes={data.mutes} />
