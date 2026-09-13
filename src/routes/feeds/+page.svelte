<script lang="ts">
  import { onDestroy } from 'svelte';
  import { useReader, message } from '$lib/client/reader.svelte';
  import { api } from '$lib/client/api';
  import FeedRow from '$lib/components/FeedRow.svelte';
  import FeedImport from '$lib/components/FeedImport.svelte';
  const reader = useReader();
  let address = $state(''),
    pending = $state(false),
    pendingVisible = $state(false),
    addError = $state(''),
    confirming = $state<string | null>(null),
    deleting = $state<string | null>(null),
    limit = $state(100),
    newIds = $state.raw(new Set<string>()),
    replacement = $state<string | null>(null);
  let revealTimer: ReturnType<typeof setTimeout> | undefined;
  const unread = $derived(
    new Map(reader.feeds.feeds.map((feed) => [feed.id, reader.counts(feed.id).unread])),
  );
  const issueCount = $derived(Object.values(reader.feeds.health).filter((health) => health.error).length);
  async function add(event: SubmitEvent) {
    event.preventDefault();
    if (pending) return;
    pending = true;
    addError = '';
    replacement = null;
    revealTimer = setTimeout(() => (pendingVisible = true), 120);
    try {
      const result = await api.addFeed(address);
      newIds = new Set([result.feed.id]);
      replacement = pendingVisible ? result.feed.id : null;
      reader.feeds = {
        feeds: [result.feed, ...reader.feeds.feeds.filter((feed) => feed.id !== result.feed.id)],
        health: { ...reader.feeds.health, [result.feed.id]: result.health },
      };
      const removed = new Set(result.removedIds);
      reader.entries = reader.entries.filter((entry) => !removed.has(entry.id));
      reader.receive(result.entries);
      address = '';
      reader.toast(
        `Feed added · ${result.entries.length} ${result.entries.length === 1 ? 'entry' : 'entries'} found`,
      );
    } catch (error) {
      addError = message(error);
    } finally {
      clearTimeout(revealTimer);
      pending = false;
      pendingVisible = false;
    }
  }
  async function remove(id: string, label: string) {
    if (deleting) return;
    if (confirming !== id) {
      confirming = id;
      return;
    }
    deleting = id;
    try {
      await api.deleteFeed(id);
      reader.feeds = { ...reader.feeds, feeds: reader.feeds.feeds.filter((feed) => feed.id !== id) };
      reader.entries = reader.entries.filter((entry) => entry.feedId !== id);
      reader.toast(`${label || 'Feed'} removed`);
    } catch (error) {
      reader.toast(`Error: ${message(error)}`);
    } finally {
      confirming = null;
      deleting = null;
    }
  }
  onDestroy(() => clearTimeout(revealTimer));
</script>

<svelte:document
  onclick={(event) => {
    if (!deleting && event.target instanceof Element && !event.target.closest('.btn-feed-delete'))
      confirming = null;
  }}
  onkeydown={(event) => {
    if (event.key === 'Escape') confirming = null;
  }}
/>
<div class="page feeds-page" data-page="feeds">
  <div class="page-header feeds-header">
    <div>
      <h1 class="page-title">Feeds</h1>
      <div class="feeds-subtitle">
        {reader.feeds.feeds.length} sources · {[...unread.values()].reduce((sum, n) => sum + n, 0)} unread{issueCount
          ? ` · ${issueCount} ${issueCount === 1 ? 'issue' : 'issues'}`
          : ''}
      </div>
    </div>
  </div>
  <div class="feed-tools">
    <div class="add-form-wrap">
      <form class="add-form" onsubmit={add} aria-busy={pending || undefined}>
        <label class="visually-hidden" for="add-feed-url">Feed or site address</label>
        <input
          class="search-input"
          id="add-feed-url"
          name="url"
          placeholder="Feed or site URL…"
          required
          autocomplete="off"
          aria-autocomplete="none"
          autocapitalize="none"
          spellcheck={false}
          bind:value={address}
          oninput={() => (addError = '')}
          disabled={pending}
        />
        <button class="btn btn-primary" class:is-busy={pending} type="submit" disabled={pending}
          >{pending ? 'Checking…' : 'Add'}</button
        >
      </form>
      <div class="add-feed-status" class:is-visible={!!addError} aria-live="polite" aria-hidden={!addError}>
        <div class="add-feed-status-inner">{addError ? `Couldn’t add feed: ${addError}` : ''}</div>
      </div>
    </div>
    <FeedImport onimport={(ids) => (newIds = ids)} />
  </div>
  <div class="feed-list-header" aria-hidden="true" hidden={!reader.feeds.feeds.length}>
    <span>Subscription</span>
    <div class="feed-list-header-metrics"><span>Unread</span><span>Checked</span></div>
    <span></span>
  </div>
  <div class="feed-list" role="list" aria-busy={pending || undefined}>
    {#if pendingVisible}<FeedRow {address} active replacement={!!replacement} />{/if}
    {#each reader.feeds.feeds.slice(0, limit) as feed, index (feed.id)}
      <FeedRow
        {feed}
        health={reader.feeds.health[feed.id]}
        unread={unread.get(feed.id) ?? 0}
        total={reader.counts(feed.id).total}
        active={newIds.has(feed.id)}
        delay={Math.min(index * 30, 150)}
        replacement={replacement === feed.id}
        confirming={confirming === feed.id}
        deleting={deleting === feed.id}
        onremove={() => remove(feed.id, feed.label)}
      />
    {/each}
    {#if !reader.feeds.feeds.length && !pendingVisible}<div class="empty-state">
        No feeds yet. Add one above!
      </div>{/if}
    {#if reader.feeds.feeds.length > limit}<div class="feed-load-more">
        <button class="btn" onclick={() => (limit += 100)}>
          Show {Math.min(100, reader.feeds.feeds.length - limit)} more ({reader.feeds.feeds.length - limit} remaining)
        </button>
      </div>{/if}
  </div>
</div>

<style>
  .feed-list {
    display: flex;
    flex-direction: column;
  }

  .feed-list-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 190px 40px;
    align-items: center;
    gap: var(--spacing-sm);
  }

  .feed-list-header-metrics {
    display: grid;
    grid-template-columns: 64px minmax(0, 1fr);
    align-items: center;
    gap: var(--spacing-sm);
  }

  .feed-tools,
  .add-form {
    display: flex;
    gap: var(--spacing-xs);
  }

  .add-form-wrap {
    flex: 1;
    min-width: 0;
  }

  .feed-tools {
    align-items: flex-start;
    margin-bottom: var(--spacing-md);
  }

  .add-form input {
    flex: 1;
  }

  .add-form {
    min-width: 0;
    width: 100%;
  }

  .add-form .btn-primary {
    width: 92px;
  }

  .feeds-subtitle {
    color: var(--muted);
    font-size: 0.85em;
    font-weight: 500;
    margin-top: 1px;
  }

  .feed-tools .search-input {
    margin-bottom: 0;
  }

  .add-feed-status {
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    overflow: hidden;
    color: var(--danger);
    font-size: 0.78em;
    font-weight: 500;
    line-height: 1.35;
    transition:
      grid-template-rows 180ms cubic-bezier(0.2, 0, 0, 1),
      opacity 140ms ease;
  }

  .add-feed-status.is-visible {
    grid-template-rows: 1fr;
    opacity: 1;
  }

  .add-feed-status-inner {
    min-height: 0;
    overflow: hidden;
    padding: 5px 2px 0;
  }

  .feed-list {
    position: relative;
  }

  .feed-list-header {
    padding: 0 var(--spacing-md) 6px;
    color: var(--muted);
    font-size: 0.7em;
    font-weight: 600;
    letter-spacing: 0.035em;
  }

  .feed-list-header-metrics {
    text-align: right;
  }

  .feed-load-more {
    display: flex;
    justify-content: center;
    padding: var(--spacing-md);
  }

  @media (max-width: 699px) {
    .feed-list-header {
      display: none;
    }

    .feed-tools {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--spacing-xs);
    }

    .add-form {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
    }

    .add-form-wrap {
      width: 100%;
    }

    .add-form input {
      min-width: 0;
      font-size: 16px;
    }
  }

  .feed-tools {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    row-gap: 0;
  }
  @media (max-width: 699px) {
    .feed-tools {
      grid-template-columns: minmax(0, 1fr);
      row-gap: var(--spacing-xs);
    }
  }
</style>
