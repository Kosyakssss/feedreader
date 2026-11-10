<script lang="ts">
  import EntryList from '#lib/components/EntryList.svelte';
  import { Rows } from '#lib/rows.svelte.ts';
  import type { Entry } from '#lib/server/store.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const rows = $derived(new Rows(data.entries));
  let more = $derived(data.more);
  let loading = $state(false);
  let failed = $state(false);

  // The next 200, after the last entry shown.
  async function showMore(): Promise<void> {
    const last = rows.list.at(-1);
    if (!last || loading) return;
    loading = true;
    failed = false;
    try {
      const response = await fetch(`/api/timeline?after=${last.published_at}:${last.id}`);
      if (!response.ok) throw new Error(String(response.status));
      const page: { entries: Entry[]; more: boolean } = await response.json();
      rows.list = [...rows.list, ...page.entries];
      more = page.more;
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head><title>Timeline</title></svelte:head>

<EntryList {rows} />
{#if more}
  <button class="more" class:failed disabled={loading} onclick={showMore}>Show more</button>
{/if}
