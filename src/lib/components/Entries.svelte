<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { useReader } from '$lib/client/reader.svelte';
  import { Selection } from '$lib/client/selection.svelte';
  import { reveal } from '$lib/client/motion';
  import EntryCard from './EntryCard.svelte';
  import BulkActions from './BulkActions.svelte';
  import Icon from './Icon.svelte';
  let { feedId, starred = false }: { feedId?: string; starred?: boolean } = $props();
  const reader = useReader();
  let filter = $state<'all' | 'unread' | 'read'>('all'),
    limit = $state(50),
    root = $state<HTMLDivElement>();
  const source = $derived(
    reader.entries.filter(
      (entry) => (!feedId || entry.feedId === feedId) && (!starred || entry.state.starred),
    ),
  );
  const counts = $derived(reader.counts(feedId, starred));
  const filteredCount = $derived(
    filter === 'all' ? counts.total : filter === 'unread' ? counts.unread : counts.total - counts.unread,
  );
  const unread = $derived(source.filter((entry) => !entry.state.read));
  const filtered = $derived(
    filter === 'all'
      ? source
      : source.filter((entry) => (filter === 'read' ? entry.state.read : !entry.state.read)),
  );
  const visible = $derived(filtered.slice(0, limit));
  const selection = new Selection(() => visible);
  const title = $derived(
    starred ? 'Starred' : reader.feeds.feeds.find((feed) => feed.id === feedId)?.label || 'Feed',
  );
  $effect(() => {
    void feedId;
    void starred;
    untrack(() => {
      filter = 'all';
      limit = 50;
      selection.reset();
    });
  });
  $effect(() => {
    const ids = new Set(reader.entries.map((entry) => entry.id));
    for (const id of selection.ids) if (!ids.has(id)) selection.ids.delete(id);
    if (selection.focused && !ids.has(selection.focused)) selection.focused = null;
  });
  $effect(() => {
    document.body.classList.toggle('bulk-active', selection.ids.size > 0);
    return () => document.body.classList.remove('bulk-active');
  });
  $effect.pre(() => {
    if (!visible.length || !root || scrollY <= 72 || !reader.newIds.size) return;
    const top = document.querySelector('.nav-bar')?.getBoundingClientRect().bottom ?? 0;
    const anchor = [...root.querySelectorAll<HTMLElement>('.entry-slot')].find(
      (row) => row.getBoundingClientRect().bottom > top,
    );
    if (!anchor) return;
    const y = anchor.getBoundingClientRect().top;
    void tick().then(() => {
      if (anchor.isConnected) window.scrollBy(0, anchor.getBoundingClientRect().top - y);
    });
  });
  function choose(value: typeof filter) {
    if (!reader.complete) return;
    filter = value;
    limit = 50;
    selection.reset();
  }
  async function markAll() {
    if (!reader.complete) return;
    const ids = unread.map((entry) => entry.id);
    if (ids.length && (await reader.mark(ids, { read: true }))) reader.toast(`${ids.length} marked as read`);
  }
  async function keydown(event: KeyboardEvent) {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      (event.target instanceof Element &&
        event.target.matches('input,textarea,select,[contenteditable=true]'))
    )
      return;
    if (document.querySelector('dialog[open]') || document.body.classList.contains('nav-menu-open')) return;
    const key = event.key.toLowerCase();
    if (key === 'j' || key === 'k') {
      selection.move(key === 'j' ? 1 : -1, event.shiftKey);
      await tick();
      root?.querySelector('.entry-focused')?.scrollIntoView({ block: 'nearest' });
    } else if (key === 'a') void markAll();
    else if (key === 'escape') {
      if (selection.ids.size) selection.clear();
      else selection.reset();
    } else {
      const entry = reader.entries.find((entry) => entry.id === selection.focused);
      if (!entry) return;
      if (key === 'o') reader.open(entry);
      else if (key === 'm') reader.toggle(entry.id, 'read');
      else if (key === 's') reader.toggle(entry.id, 'starred');
      else if (key === 'x') selection.toggle(entry.id, visible.indexOf(entry));
      else return;
    }
    event.preventDefault();
  }
</script>

<svelte:document
  onkeydown={keydown}
  onpointerdown={(event) => selection.dismiss(event)}
  onpointermove={(event) => {
    selection.dismiss(event);
    selection.movePointer(event);
  }}
  onpointerup={(event) => selection.up(event)}
  onpointercancel={(event) => selection.up(event)}
/>
<div class="page" data-page={starred ? 'starred' : feedId ? `feed:${feedId}` : 'timeline'} bind:this={root}>
  {#if starred || feedId}<div class="page-header"><h1 class="page-title">{title}</h1></div>{/if}
  {#if !starred}<div class="toolbar">
      <div class="filter-tabs" role="group" aria-label="Filter entries">
        {#each ['all', 'unread', 'read'] as value}<button
            type="button"
            class:active={filter === value}
            aria-pressed={filter === value}
            disabled={!reader.complete}
            onclick={() => choose(value as typeof filter)}
          >
            {value[0]!.toUpperCase() + value.slice(1)} ({value === 'all'
              ? counts.total
              : value === 'unread'
                ? counts.unread
                : counts.total - counts.unread})
          </button>{/each}
      </div>
      <div class="timeline-actions">
        <button class="btn" disabled={!reader.complete} onclick={() => reader.openMany(unread, 'unread')}
          >Open all unread<Icon name="external-link" class="ui-icon button-icon" /></button
        >
        <button class="btn" disabled={!reader.complete} onclick={markAll}
          >Mark all read<Icon name="check" class="ui-icon button-icon" /></button
        >
        <button
          class="btn"
          disabled={reader.status?.refreshing}
          aria-label={reader.status?.refreshing ? 'Refreshing feeds' : 'Refresh feeds'}
          aria-busy={reader.status?.refreshing || undefined}
          onclick={() => reader.refresh(true)}
          >Refresh<Icon name="refresh" class="ui-icon button-icon" /></button
        >
      </div>
    </div>{/if}
  <div id="entry-list">
    {#if !visible.length}<div class="empty-state">
        {!reader.complete && reader.syncing ? 'Loading saved entries…' : 'No entries'}
      </div>
    {:else}<div class="entry-list" role="list">
        {#each visible as entry, index (entry.id)}
          {@const active = reader.newIds.has(entry.id)}
          {@const delay = Math.min(index * 34, 136)}
          <div class="entry-slot" role="listitem" data-id={entry.id} in:reveal={{ active, delay }}>
            <EntryCard {entry} {index} {selection} {active} {delay} />
          </div>
        {/each}
      </div>
      {#if filteredCount > limit}<div class="load-more">
          <button class="btn" disabled={!reader.complete} onclick={() => (limit += 50)}
            >Show more ({filteredCount - limit} remaining)</button
          >
        </div>{/if}
    {/if}
  </div>
</div>
<BulkActions {selection} />

<style>
  .toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--spacing-sm);
    margin-bottom: var(--spacing-sm);
  }

  .filter-tabs {
    display: flex;
    gap: var(--spacing-xs);
  }

  .timeline-actions {
    display: flex;
    gap: var(--spacing-xs);
    justify-self: end;
  }

  .entry-list {
    display: flex;
    flex-direction: column;
  }

  .entry-slot {
    flex: none;
    min-height: 0;
    content-visibility: auto;
    contain-intrinsic-block-size: auto 58px;
  }

  .load-more {
    display: flex;
    justify-content: center;
    padding: var(--spacing-md);
  }

  .filter-tabs button {
    background: none;
    border: none;
    color: var(--muted);
    font-size: 0.8em;
    font-weight: 500;
    cursor: pointer;
    padding: 5px 12px;
    border-radius: 0;
    font-family: var(--font-sans);
    transition:
      color var(--duration-default),
      background var(--duration-default),
      transform 100ms ease;
  }

  .filter-tabs button:hover {
    color: var(--foreground);
    background: var(--surface-hover);
  }

  .filter-tabs button:active {
    transform: scale(0.97);
  }

  .filter-tabs button.active {
    color: var(--accent);
    font-weight: 600;
    background: var(--accent-soft);
  }

  .entry-slot + .entry-slot {
    margin-top: -0.5px;
  }

  @media (max-width: 699px) {
    .filter-tabs button {
      background: var(--surface);
      border: 0.5px solid var(--border);
      padding: 6px var(--spacing-sm);
      text-align: center;
    }

    .toolbar {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--spacing-xs);
    }

    .filter-tabs,
    .timeline-actions {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      width: 100%;
    }

    .timeline-actions {
      justify-self: stretch;
    }

    .filter-tabs button,
    .timeline-actions .btn {
      min-width: 0;
      text-align: center;
      white-space: nowrap;
    }
  }
</style>
