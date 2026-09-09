<script lang="ts">
  import { onDestroy } from 'svelte';
  import { useReader, message } from '$lib/client/reader.svelte';
  import { api } from '$lib/client/api';
  import { timeAgo } from '$lib/client/values';
  import { reveal, revealContent, collapse } from '$lib/client/motion';
  import Icon from '$lib/components/Icon.svelte';
  const reader = useReader();
  let address = $state(''),
    pending = $state(false),
    pendingVisible = $state(false),
    addError = $state(''),
    confirming = $state<string | null>(null),
    deleting = $state<string | null>(null),
    limit = $state(100),
    fileInput = $state<HTMLInputElement>();
  let revealTimer: ReturnType<typeof setTimeout> | undefined;
  let newIds = $state.raw(new Set<string>()),
    replacement = $state<string | null>(null);
  let imported = $state<{ ids: string[]; total: number; reading: boolean } | null>(null);
  const unread = $derived(
    new Map(reader.feeds.feeds.map((feed) => [feed.id, reader.counts(feed.id).unread])),
  );
  const issueCount = $derived(
    Object.values(reader.feeds.health ?? {}).filter((health) => health.error).length,
  );
  const progress = $derived.by(() => {
    const results =
      imported?.ids.map((id) => reader.feeds.health?.[id]).filter((health) => health && !health.checking) ??
      [];
    return {
      completed: results.length,
      failed: results.filter((health) => health?.error).length,
      succeeded: results.filter((health) => !health?.error).length,
    };
  });
  const importing = $derived(!!imported && (imported.reading || progress.completed < imported.total));
  const display = (url: string) => url.replace(/^https?:\/\/(?:www\.)?/i, '').replace(/\/$/, '');
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
        ...reader.feeds,
        feeds: [result.feed, ...reader.feeds.feeds.filter((feed) => feed.id !== result.feed.id)],
        health: { ...reader.feeds.health, [result.feed.id]: result.health },
      };
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
  async function importFile() {
    const file = fileInput?.files?.[0];
    if (!file || importing) return;
    imported = { ids: [], total: 0, reading: true };
    const body = new FormData();
    body.append('file', file);
    try {
      const result = await api.importFeeds(body);
      newIds = new Set(result.feeds.map((feed) => feed.id));
      reader.feeds = {
        ...reader.feeds,
        feeds: [...result.feeds, ...reader.feeds.feeds.filter((feed) => !newIds.has(feed.id))],
        health: {
          ...reader.feeds.health,
          ...Object.fromEntries(
            result.feeds.map((feed) => [
              feed.id,
              { lastFetched: null, error: null, entryCount: 0, checking: true },
            ]),
          ),
        },
      };
      imported = result.added ? { ids: [...newIds], total: result.added, reading: false } : null;
      if (result.added) void reader.refresh(false, [...newIds]);
      else reader.toast(`No new feeds · ${result.skipped} skipped`);
    } catch (error) {
      imported = null;
      reader.toast(`Error: ${message(error)}`);
    } finally {
      if (fileInput) fileInput.value = '';
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
        <label class="visually-hidden" for="add-feed-url">Feed or site address</label><input
          class="search-input"
          id="add-feed-url"
          name="url"
          placeholder="Feed, site URL, or @handle…"
          required
          autocomplete="off"
          aria-autocomplete="none"
          autocapitalize="none"
          spellcheck={false}
          bind:value={address}
          oninput={() => (addError = '')}
          disabled={pending}
        /><button class="btn btn-primary" class:is-busy={pending} type="submit" disabled={pending}
          >{pending ? 'Checking…' : 'Add'}</button
        >
      </form>
      <div class="add-feed-status" class:is-visible={!!addError} aria-live="polite" aria-hidden={!addError}>
        <div class="add-feed-status-inner">{addError ? `Couldn’t add feed: ${addError}` : ''}</div>
      </div>
    </div>
    <div class="feed-file-actions">
      <button class="btn" disabled={importing} onclick={() => fileInput?.click()}>Import OPML</button><input
        type="file"
        accept=".opml,.xml"
        hidden
        bind:this={fileInput}
        onchange={importFile}
      /><a class="btn" href={reader.path('/api/feeds/export')} download="feedreader.opml">Export OPML</a>
    </div>
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
  <div class="feed-list-header" aria-hidden="true" hidden={!reader.feeds.feeds.length}>
    <span>Subscription</span>
    <div class="feed-list-header-metrics"><span>Unread</span><span>Checked</span></div>
    <span></span>
  </div>
  <div class="feed-list" role="list" aria-busy={pending || importing || undefined}>
    {#if pendingVisible}<div
        class="feed-slot feed-pending-slot"
        in:reveal={{ active: true }}
        out:collapse={{ replacement: !!replacement }}
      >
        <div class="feed-item feed-pending" role="status" in:revealContent={{ active: true }}>
          <div class="feed-info">
            <span class="feed-label feed-pending-label">Finding and checking feed…</span>
            <div class="feed-meta feed-pending-address" title={address}>{display(address)}</div>
          </div>
          <div class="feed-metrics feed-pending-metrics">
            <span class="feed-pending-metric-spacer"></span><span class="feed-pending-activity"
              ><span class="feed-pending-spinner"></span></span
            >
          </div>
          <span class="feed-pending-action"></span>
        </div>
      </div>{/if}
    {#each reader.feeds.feeds.slice(0, limit) as feed, index (feed.id)}
      {@const health = reader.feeds.health?.[feed.id]}
      {@const count = unread.get(feed.id) ?? 0}
      {@const last = health?.lastFetched ? timeAgo(new Date(health.lastFetched).toISOString()) : null}
      <div
        class="feed-slot"
        role="listitem"
        data-feed-id={feed.id}
        in:reveal={{
          active: newIds.has(feed.id),
          delay: Math.min(index * 30, 150),
          replacement: replacement === feed.id,
        }}
        out:collapse
      >
        <div
          class="feed-item"
          in:revealContent={{
            active: newIds.has(feed.id) && replacement !== feed.id,
            delay: Math.min(index * 30, 150),
          }}
        >
          <div class="feed-info">
            <a class="feed-label" dir="auto" href={reader.path(`/feed/${encodeURIComponent(feed.id)}`)}
              >{feed.label}</a
            >
            <div class="feed-meta" title={feed.url}>{display(feed.url)}</div>
          </div>
          <div class="feed-metrics">
            <span
              class="feed-unread"
              class:has-unread={count > 0}
              aria-label={`${count} unread ${count === 1 ? 'entry' : 'entries'}`}
              ><span class="feed-unread-value">{count || '—'}</span><span class="feed-unread-context">
                unread</span
              ></span
            ><span
              class="feed-health"
              class:has-error={!!health?.error}
              class:is-checking={health?.checking}
              title={health?.error || (!health?.entryCount && last ? 'Feed returned no entries' : undefined)}
              >{health?.checking ? 'Checking…' : health?.error ? 'Error' : last || 'Not checked'}</span
            >
          </div>
          <button
            class="btn btn-feed-delete"
            class:is-confirming={confirming === feed.id}
            class:is-deleting={deleting === feed.id}
            disabled={deleting === feed.id}
            aria-busy={deleting === feed.id || undefined}
            title={deleting === feed.id
              ? 'Removing feed'
              : confirming === feed.id
                ? 'Click again to remove feed'
                : 'Remove feed'}
            aria-label={deleting === feed.id
              ? `Removing ${feed.label}`
              : confirming === feed.id
                ? `Confirm removal of ${feed.label}`
                : `Remove ${feed.label}`}
            onclick={() => remove(feed.id, feed.label)}
            ><Icon name="close" class="ui-icon feed-delete-icon feed-delete-icon-idle" /><Icon
              name="trash"
              class="ui-icon feed-delete-icon feed-delete-icon-confirm"
            /><span class="feed-delete-spinner"></span></button
          >
        </div>
      </div>
    {/each}
    {#if !reader.feeds.feeds.length && !pendingVisible}<div class="empty-state">
        No feeds yet. Add one above!
      </div>{/if}
    {#if reader.feeds.feeds.length > limit}<div class="feed-load-more">
        <button class="btn" onclick={() => (limit += 100)}
          >Show {Math.min(100, reader.feeds.feeds.length - limit)} more ({reader.feeds.feeds.length - limit} remaining)</button
        >
      </div>{/if}
  </div>
</div>
