<script lang="ts">
  import { refreshAll } from '$app/navigation';
  import { feedPath } from '#lib/format.ts';
  import type { Entry } from '#lib/server/store.ts';

  type Found = { url: string; title: string; followed: boolean; failed?: boolean };

  let { entry, onremove }: { entry: Entry; onremove: () => void } = $props();

  const site = $derived(new URL(entry.url).hostname.replace(/^www\./, ''));
  let looking = $state(true);
  let feeds = $state<Found[]>([]);

  // A page from no feed: look for the feeds its site offers, once, on opening.
  $effect(() => {
    if (!entry.page) return;
    fetch(`/api/discover?url=${encodeURIComponent(entry.url)}`)
      .then((response) => response.json())
      .then((found: { feeds: Found[] }) => (feeds = found.feeds))
      .catch(() => (feeds = []))
      .finally(() => (looking = false));
  });

  async function follow(feed: Found): Promise<void> {
    feed.failed = false;
    const response = await fetch('/api/feeds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: feed.url }),
    }).catch(() => null);
    if (!response?.ok) {
      feed.failed = true;
      return;
    }
    feed.followed = true;
    await refreshAll(); // the new feed joins the breadcrumb menus
  }
</script>

<div class="card-body">
  <div><button onclick={onremove}>Remove bookmark</button></div>
  {#if !entry.page}
    <p class="muted">From <a href={feedPath(entry.source_id)}>{entry.feed}</a></p>
  {:else if looking}
    <p class="muted">Looking for feeds on {site}…</p>
  {:else if feeds.length}
    <ol>
      {#each feeds as feed (feed.url)}
        <li>
          <span>{feed.title || site}</span>
          <span class="muted">{new URL(feed.url).pathname}</span>
          {#if feed.followed}
            <span class="muted">Following</span>
          {:else}
            <button class:failed={feed.failed} onclick={() => follow(feed)}>Follow</button>
          {/if}
        </li>
      {/each}
    </ol>
  {:else}
    <p class="muted">No feeds on {site}.</p>
  {/if}
</div>
