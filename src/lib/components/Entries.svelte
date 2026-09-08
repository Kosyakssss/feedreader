<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { useReader } from '$lib/client/reader.svelte';
  import { Selection } from '$lib/client/selection.svelte';
  import { safeHttpUrl, timeAgo } from '$lib/client/values';
  import { reveal, revealContent } from '$lib/client/motion';
  import Icon from './Icon.svelte';
  let { feedId, starred = false }: { feedId?: string; starred?: boolean } = $props();
  const reader = useReader();
  let filter = $state<'all' | 'unread' | 'read'>('all'),
    limit = $state(50);
  let root = $state<HTMLDivElement>();
  const source = $derived(
    reader.entries.filter(
      (entry) => (!feedId || entry.feedId === feedId) && (!starred || entry.state.starred),
    ),
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
    const rows = visible;
    if (!rows.length || !root || scrollY <= 72 || !reader.newIds.size) return;
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
    filter = value;
    limit = 50;
    selection.reset();
  }
  async function markAll() {
    const ids = unread.map((entry) => entry.id);
    if (ids.length && (await reader.mark(ids, { read: true }))) reader.toast(`${ids.length} marked as read`);
  }
  async function bulk(action: string) {
    const entries = reader.entries.filter((entry) => selection.ids.has(entry.id));
    if (action === 'open') await reader.openMany(entries, 'selected');
    else if (action !== 'cancel')
      await reader.mark(
        entries.map((entry) => entry.id),
        action === 'star' ? { starred: true } : { read: action === 'read' },
      );
    selection.clear();
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
    const key = event.key.toLowerCase();
    if (document.querySelector('[data-shortcuts-open]') || document.body.classList.contains('nav-menu-open'))
      return;
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
  {#if !starred}
    <div class="toolbar">
      <div class="filter-tabs" role="group" aria-label="Filter entries">
        {#each ['all', 'unread', 'read'] as value}<button
            type="button"
            class:active={filter === value}
            aria-pressed={filter === value}
            onclick={() => choose(value as typeof filter)}
            >{value[0]!.toUpperCase() + value.slice(1)} ({value === 'all'
              ? source.length
              : value === 'unread'
                ? unread.length
                : source.length - unread.length})</button
          >{/each}
      </div>
      <div class="timeline-actions">
        <button class="btn" onclick={() => reader.openMany(unread, 'unread')}
          >Open all unread<Icon name="external-link" class="ui-icon button-icon" /></button
        >
        <button class="btn" onclick={markAll}
          >Mark all read<Icon name="check" class="ui-icon button-icon" /></button
        >
        <button
          class="btn"
          disabled={reader.loading || reader.status?.refreshing}
          aria-label={reader.status?.refreshing ? 'Refreshing feeds' : 'Refresh feeds'}
          aria-busy={reader.status?.refreshing || undefined}
          onclick={() => reader.refresh(true)}
          >Refresh<Icon name="refresh" class="ui-icon button-icon" /></button
        >
      </div>
    </div>
  {/if}
  <div id="entry-list">
    {#if reader.loading}<div class="empty-state">Loading saved entries…</div>
    {:else if !visible.length}<div class="empty-state">No entries</div>
    {:else}
      <div class="entry-list" role="list">
        {#each visible as entry, index (entry.id)}
          {@const active = reader.newIds.has(entry.id)}
          {@const delay = Math.min(index * 34, 136)}
          <div class="entry-slot" role="listitem" data-id={entry.id} in:reveal={{ active, delay }}>
            <div
              class="entry-card"
              class:entry-read={entry.state.read}
              class:entry-unread={!entry.state.read}
              class:entry-selected={selection.ids.has(entry.id)}
              class:entry-focused={selection.focused === entry.id}
              data-id={entry.id}
              data-idx={index}
              in:revealContent={{ active, delay }}
            >
              <label class="entry-checkbox" onpointerdown={(event) => selection.down(event, entry.id, index)}
                ><input
                  type="checkbox"
                  aria-label={`Select ${entry.title || 'entry'}`}
                  checked={selection.ids.has(entry.id)}
                  onclick={(event) => {
                    if (selection.suppressClick) event.preventDefault();
                    else selection.toggle(entry.id, index, event.shiftKey);
                  }}
                /></label
              >
              <span class="entry-leading-space" aria-hidden="true"></span>
              <div class="entry-content">
                <span class="entry-title-slot">
                  {#if safeHttpUrl(entry.url)}<a
                      class="entry-title"
                      dir="auto"
                      href={entry.url}
                      target="_blank"
                      rel="noopener"
                      onclick={(event) => {
                        if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                          event.preventDefault();
                          reader.open(entry);
                        }
                      }}>{entry.title || 'Untitled'}</a
                    >
                  {:else}<span class="entry-title" dir="auto">{entry.title || 'Untitled'}</span>{/if}
                </span><span class="entry-meta" dir="auto"
                  >{entry.feedLabel || 'Unknown'} · {timeAgo(entry.published)}</span
                >
              </div>
              <div class="entry-actions">
                <button
                  class="btn-icon btn-star"
                  class:starred={entry.state.starred}
                  aria-pressed={!!entry.state.starred}
                  title={entry.state.starred ? 'Unstar' : 'Star'}
                  aria-label="Star entry"
                  onclick={() => reader.toggle(entry.id, 'starred')}
                  ><Icon name={entry.state.starred ? 'star-filled' : 'star'} /></button
                >
                <button
                  class="btn-icon btn-mark"
                  aria-pressed={!!entry.state.read}
                  title={entry.state.read ? 'Mark unread' : 'Mark read'}
                  aria-label="Read entry"
                  onclick={() => reader.toggle(entry.id, 'read')}
                  ><Icon name={entry.state.read ? 'circle' : 'circle-filled'} /></button
                >
              </div>
            </div>
          </div>
        {/each}
      </div>
      {#if filtered.length > limit}<div class="load-more">
          <button class="btn" onclick={() => (limit += 50)}
            >Show more ({filtered.length - limit} remaining)</button
          >
        </div>{/if}
    {/if}
  </div>
</div>
{#if selection.ids.size}<div class="bulk-bar" id="bulk-bar">
    <span class="bulk-count">{selection.ids.size} selected</span><button
      class="btn"
      onclick={() => bulk('read')}>Mark read</button
    ><button class="btn" onclick={() => bulk('unread')}>Mark unread</button><button
      class="btn"
      onclick={() => bulk('open')}>Open<Icon name="external-link" class="ui-icon button-icon" /></button
    ><button class="btn" onclick={() => bulk('star')}
      ><Icon name="star" class="ui-icon button-icon" />Star</button
    ><button class="btn" id="bulk-cancel" onclick={() => bulk('cancel')}>Cancel</button>
  </div>{/if}
