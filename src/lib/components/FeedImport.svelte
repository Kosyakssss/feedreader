<script lang="ts">
  import { base } from '$app/paths';
  import { useReader, message } from '$lib/client/reader.svelte';
  import { api } from '$lib/client/api';
  let { onimport }: { onimport: (ids: Set<string>) => void } = $props();
  const reader = useReader();
  let fileInput = $state<HTMLInputElement>();
  let imported = $state<{ ids: string[]; total: number; reading: boolean } | null>(null);
  const progress = $derived.by(() => {
    const results =
      imported?.ids.map((id) => reader.feeds.health[id]).filter((health) => health?.lastFetched != null) ??
      [];
    return {
      completed: results.length,
      failed: results.filter((health) => health?.error).length,
      succeeded: results.filter((health) => !health?.error).length,
    };
  });
  const importing = $derived(!!imported && (imported.reading || progress.completed < imported.total));
  async function importFile() {
    const file = fileInput?.files?.[0];
    if (!file || importing) return;
    imported = { ids: [], total: 0, reading: true };
    const body = new FormData();
    body.append('file', file);
    try {
      const result = await api.importFeeds(body);
      const ids = new Set(result.feeds.map((feed) => feed.id));
      reader.feeds = {
        feeds: [...result.feeds, ...reader.feeds.feeds.filter((feed) => !ids.has(feed.id))],
        health: {
          ...Object.fromEntries(result.feeds.map((feed) => [feed.id, { lastFetched: null, error: null }])),
          ...reader.feeds.health,
        },
      };
      onimport(ids);
      imported = result.added ? { ids: [...ids], total: result.added, reading: false } : null;
      if (!result.added) reader.toast(`No new feeds · ${result.skipped} skipped`);
    } catch (error) {
      imported = null;
      reader.toast(`Error: ${message(error)}`);
    } finally {
      if (fileInput) fileInput.value = '';
    }
  }
</script>

<div class="feed-file-actions">
  <button class="btn" disabled={importing} onclick={() => fileInput?.click()}>Import OPML</button>
  <input type="file" accept=".opml,.xml" hidden bind:this={fileInput} onchange={importFile} />
  <a class="btn" href={`${base}/api/feeds/export`} download="feedreader.opml">Export OPML</a>
</div>
<div class="feed-import-slot" class:is-visible={!!imported} aria-hidden={!imported}>
  <div class="feed-import-slot-inner">
    <section class="feed-import-status" aria-live="polite">
      <div class="feed-import-title">
        {imported?.reading
          ? 'Reading subscriptions…'
          : importing
            ? `Checking imported feeds · ${progress.completed} / ${imported?.total}`
            : `Import complete · ${progress.succeeded} checked${progress.failed ? ` · ${progress.failed} need attention` : ''}`}
      </div>
      <progress
        class="feed-import-meter"
        hidden={!imported?.total}
        max={imported?.total || 1}
        value={progress.completed}
      ></progress>
      <div class="feed-import-detail">
        {imported?.reading
          ? ''
          : importing
            ? `${progress.succeeded} ready${progress.failed ? ` · ${progress.failed} failed` : ''}`
            : `${imported?.total ?? 0} subscriptions added`}
      </div>
    </section>
  </div>
</div>

<style>
  .feed-file-actions {
    display: flex;
    gap: var(--spacing-xs);
  }

  .feed-file-actions {
    flex: none;
  }

  .feed-import-slot {
    display: grid;
    grid-template-rows: 0fr;
    margin-bottom: 0;
    opacity: 0;
    transition:
      grid-template-rows 220ms cubic-bezier(0.2, 0, 0, 1),
      margin-bottom 220ms cubic-bezier(0.2, 0, 0, 1),
      opacity 160ms ease;
  }

  .feed-import-slot.is-visible {
    grid-template-rows: 1fr;
    margin-bottom: var(--spacing-md);
    opacity: 1;
  }

  .feed-import-slot-inner {
    min-height: 0;
    overflow: hidden;
  }

  .feed-import-status {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(120px, 220px);
    align-items: center;
    gap: 3px var(--spacing-md);
    padding: 10px var(--spacing-md);
    background: var(--accent-soft);
    border: 0.5px solid color-mix(in srgb, var(--accent) 45%, var(--border));
    color: var(--foreground);
  }

  .feed-import-title {
    font-size: 0.88em;
    font-weight: 650;
  }

  .feed-import-detail {
    color: var(--muted);
    font-size: 0.76em;
  }

  .feed-import-meter {
    grid-column: 2;
    grid-row: 1 / span 2;
    width: 100%;
    height: 5px;
    border: 0;
    border-radius: 0;
    overflow: hidden;
    accent-color: var(--accent);
  }

  .feed-import-meter::-webkit-progress-bar {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }

  .feed-import-meter::-webkit-progress-value {
    background: var(--accent);
    transition: width 220ms cubic-bezier(0.2, 0, 0, 1);
  }

  .feed-file-actions .btn {
    min-width: 0;
    text-align: center;
    text-decoration: none;
  }

  @media (max-width: 699px) {
    .feed-file-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .feed-import-status {
      grid-template-columns: minmax(0, 1fr);
    }

    .feed-import-meter {
      grid-column: 1;
      grid-row: auto;
    }
  }

  .feed-import-slot {
    grid-column: 1 / -1;
  }
  .feed-import-slot.is-visible {
    margin-top: var(--spacing-md);
    margin-bottom: 0;
  }
</style>
