<script lang="ts">
  import { resolve } from '$app/paths';
  import type { Source } from '#lib/server/store.ts';
  import Card from './Card.svelte';
  import FeedCard from './FeedCard.svelte';
  import MoreButton from './MoreButton.svelte';

  type Feed = Pick<Source, 'id' | 'label'> & Partial<Source>;

  // With `mutes`, each feed opens as a card with its settings.
  let { feeds, mutes }: { feeds: Feed[]; mutes?: Record<number, string[]> } = $props();
</script>

<ol>
  {#each feeds as feed (feed.id)}
    <li>
      <div class="row">
        <a href={resolve('/(app)/feed/[id]', { id: String(feed.id) })}>{feed.label}</a>
        {#if feed.folder}<span class="muted">{feed.folder}</span>{/if}
        {#if feed.error}<span class="failed">{feed.error}</span>{/if}
        {#if mutes}
          <span class="row-buttons"><MoreButton key="f{feed.id}" /></span>
          <Card key="f{feed.id}"><FeedCard feed={feed as Source} mutes={mutes[feed.id] ?? []} /></Card>
        {/if}
      </div>
    </li>
  {/each}
</ol>
