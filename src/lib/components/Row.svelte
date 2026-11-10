<script lang="ts">
  import { fitTitle } from '#lib/fit-title.ts';
  import { capTitle, dateLabel, displayTitle, feedPath } from '#lib/format.ts';
  import type { Entry } from '#lib/server/store.ts';

  // Without `onbookmark` the row is a plain link, as in search results.
  let { entry, failed = false, onbookmark }: { entry: Entry; failed?: boolean; onbookmark?: () => void } = $props();

  const title = $derived(capTitle(displayTitle(entry)));
  const saved = $derived(entry.state === 'bookmarked');
</script>

<li>
  <div class="row" style:view-transition-name="e{entry.id}">
    <a class="title" href={entry.url} target="_blank" rel="noopener" {@attach fitTitle(title)}>{title}</a>
    <small><a href={feedPath(entry.source_id)}>{entry.feed}</a> {dateLabel(entry.published_at)}</small>
    {#if onbookmark}
      <button class:saved class:failed onclick={onbookmark}>{saved ? 'Saved' : 'Save'}</button>
    {/if}
  </div>
</li>
