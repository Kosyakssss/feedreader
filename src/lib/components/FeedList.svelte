<script lang="ts">
  import { feedPath } from '#lib/format.ts';
  import type { Source } from '#lib/server/store.ts';

  type Feed = Pick<Source, 'id' | 'label'> & Partial<Pick<Source, 'folder' | 'error'>>;
  let { feeds }: { feeds: Feed[] } = $props();
</script>

<ol>
  {#each feeds as feed (feed.id)}
    <li>
      <a href={feedPath(feed.id)}>{feed.label}</a>
      {#if feed.folder}<span class="muted">{feed.folder}</span>{/if}
      {#if feed.error}<span class="failed">{feed.error}</span>{/if}
    </li>
  {/each}
</ol>
