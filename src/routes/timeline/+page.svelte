<script lang="ts">
  import { resolve } from '$app/paths';
  import EntryList from '#lib/components/EntryList.svelte';
  import { library, TIMELINE_STEP } from '#lib/library.svelte.ts';
  import type { Entry } from '#lib/server/store.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  // A step at a time, as reading goes on. With the library here the next
  // step is already on the device; before it is, it comes from the server.
  let shown = $state(TIMELINE_STEP);
  let fetched = $state<Entry[]>([]);
  let moreSent = $state<boolean>(); // what the server said with the last step it sent
  let loading = $state(false);
  let failed = $state(false);

  const everything = $derived(library.list([...(data.list?.entries ?? []), ...fetched], library.timeline));
  const entries = $derived(library.ready ? everything.slice(0, shown) : everything);
  const more = $derived(library.ready ? everything.length > shown : (moreSent ?? data.list?.more ?? false));

  async function showMore(): Promise<void> {
    if (library.ready) {
      shown += TIMELINE_STEP;
      return;
    }
    const last = entries.at(-1);
    if (!last || loading) return;
    loading = true;
    failed = false;
    try {
      const response = await fetch(resolve(`/api/timeline?after=${last.published_at}:${last.id}`));
      if (!response.ok) throw new Error(String(response.status));
      const page: { entries: Entry[]; more: boolean } = await response.json();
      fetched = [...fetched, ...page.entries];
      moreSent = page.more;
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head><title>Timeline</title></svelte:head>

<EntryList {entries} />
{#if more}
  <button class="more" class:failed disabled={loading} onclick={showMore}>Show more</button>
{/if}
