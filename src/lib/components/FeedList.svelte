<script lang="ts">
  import { feedPath } from '#lib/format.ts';
  import type { Source } from '#lib/server/store.ts';
  import Card from './Card.svelte';
  import FeedCard from './FeedCard.svelte';

  type Feed = Pick<Source, 'id' | 'label'> & Partial<Source>;

  // With `mutes`, each feed opens as a card with its settings.
  let { feeds, mutes }: { feeds: Feed[]; mutes?: Record<number, string[]> } = $props();
</script>

<ol>
  {#each feeds as feed (feed.id)}
    <li>
      <div class="row">
        <a href={feedPath(feed.id)}>{feed.label}</a>
        {#if feed.folder}<span class="muted">{feed.folder}</span>{/if}
        {#if feed.error}<span class="failed">{feed.error}</span>{/if}
        {#if mutes}
          <Card key="f{feed.id}"><FeedCard feed={feed as Source} mutes={mutes[feed.id] ?? []} /></Card>
        {/if}
      </div>
    </li>
  {/each}
</ol>
