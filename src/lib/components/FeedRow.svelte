<script lang="ts">
  import { base } from '$app/paths';
  import type { Feed, FeedHealth } from '$lib/types';
  import { timeAgo } from '$lib/client/entries';
  import { reveal, revealContent, collapse } from '$lib/client/motion';
  import Icon from './Icon.svelte';
  let {
    feed,
    health,
    unread = 0,
    total = 0,
    active = false,
    delay = 0,
    replacement = false,
    address = '',
    confirming = false,
    deleting = false,
    onremove,
  }: {
    feed?: Feed;
    health?: FeedHealth;
    unread?: number;
    total?: number;
    active?: boolean;
    delay?: number;
    replacement?: boolean;
    address?: string;
    confirming?: boolean;
    deleting?: boolean;
    onremove?: () => void;
  } = $props();
  const last = $derived(health?.lastFetched ? timeAgo(new Date(health.lastFetched).toISOString()) : null);
  const display = (url: string) => url.replace(/^https?:\/\/(?:www\.)?/i, '').replace(/\/$/, '');
</script>

<div
  class="feed-slot"
  class:feed-pending-slot={!feed}
  role={feed ? 'listitem' : undefined}
  data-feed-id={feed?.id}
  in:reveal={{ active, delay, replacement: !!feed && replacement }}
  out:collapse={{ replacement: !feed && replacement }}
>
  <div
    class="feed-item"
    class:feed-pending={!feed}
    role={!feed ? 'status' : undefined}
    in:revealContent={{ active: active && !replacement, delay }}
  >
    <div class="feed-info">
      {#if feed}<a class="feed-label" dir="auto" href={`${base}/feed/${encodeURIComponent(feed.id)}`}
          >{feed.label}</a
        >
        <div class="feed-meta" title={feed.url}>{display(feed.url)}</div>
      {:else}<span class="feed-label feed-pending-label">Finding and checking feed…</span>
        <div class="feed-meta feed-pending-address" title={address}>{display(address)}</div>{/if}
    </div>
    {#if feed}<div class="feed-metrics">
        <span
          class="feed-unread"
          class:has-unread={unread > 0}
          aria-label={`${unread} unread ${unread === 1 ? 'entry' : 'entries'}`}
        >
          <span class="feed-unread-value">{unread || '—'}</span><span class="feed-unread-context"
            >{' '}unread</span
          >
        </span>
        <span
          class="feed-health"
          class:has-error={!!health?.error}
          class:is-checking={health?.lastFetched === null}
          title={health?.error || (!total && last ? 'Feed returned no entries' : undefined)}
        >
          {health?.lastFetched === null ? 'Checking…' : health?.error ? 'Error' : last || 'Not checked'}
        </span>
      </div>
      <button
        class="btn btn-feed-delete"
        class:is-confirming={confirming}
        class:is-deleting={deleting}
        disabled={deleting}
        aria-busy={deleting || undefined}
        title={deleting ? 'Removing feed' : confirming ? 'Click again to remove feed' : 'Remove feed'}
        aria-label={deleting
          ? `Removing ${feed.label}`
          : confirming
            ? `Confirm removal of ${feed.label}`
            : `Remove ${feed.label}`}
        onclick={onremove}
      >
        <Icon name="close" class="ui-icon feed-delete-icon feed-delete-icon-idle" /><Icon
          name="trash"
          class="ui-icon feed-delete-icon feed-delete-icon-confirm"
        />
        <span class="feed-delete-spinner"></span>
      </button>
    {:else}<div class="feed-metrics feed-pending-metrics">
        <span></span><span class="feed-pending-activity"><span class="feed-pending-spinner"></span></span>
      </div>
      <span class="feed-pending-action"></span>{/if}
  </div>
</div>

<style>
  .feed-item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 190px 40px;
    align-items: center;
    gap: var(--spacing-sm);
  }

  .feed-info {
    min-width: 0;
  }

  .feed-metrics {
    display: grid;
    grid-template-columns: 64px minmax(0, 1fr);
    align-items: center;
    gap: var(--spacing-sm);
  }

  .feed-slot {
    flex: none;
    min-height: 0;
  }

  .feed-pending {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 190px 40px;
    align-items: center;
    gap: var(--spacing-sm);
    min-height: 58px;
    padding: 9px var(--spacing-md);
    overflow: hidden;
    color: var(--accent);
    background: var(--accent-soft);
    border: 0.5px solid transparent;
    position: relative;
  }

  .feed-pending::after {
    position: absolute;
    z-index: 1;
    border: 1px solid color-mix(in srgb, var(--accent) 82%, transparent);
    content: '';
    inset: 0;
    pointer-events: none;
  }

  .feed-pending-slot {
    position: relative;
    z-index: 2;
  }

  .feed-pending-label {
    color: var(--accent);
  }

  .feed-pending-activity {
    display: flex;
    min-height: 1.6em;
    align-items: center;
    justify-content: flex-end;
  }

  .feed-pending-spinner {
    width: 14px;
    height: 14px;
    border: 2px solid color-mix(in srgb, var(--accent) 25%, transparent);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: feed-spin 700ms linear infinite;
  }

  .feed-item {
    background: var(--surface);
    border: 0.5px solid var(--border);
    border-radius: 0;
    min-height: 58px;
    padding: 9px var(--spacing-md);
    transition: background var(--duration-default);
  }

  :global(.feed-slot) + .feed-slot {
    margin-top: -0.5px;
  }

  .feed-item:hover {
    background: var(--surface-hover);
    z-index: 1;
    position: relative;
  }

  .feed-label {
    display: block;
    font-weight: 600;
    color: var(--foreground);
    min-width: 0;
    overflow: hidden;
    text-decoration: none;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .feed-label:hover {
    color: var(--accent);
  }

  .feed-meta {
    font-size: 0.8em;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .feed-metrics {
    text-align: right;
  }

  .feed-metrics {
    color: var(--muted);
    font-size: 0.76em;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .feed-unread.has-unread {
    color: var(--accent);
    font-weight: 650;
  }

  .feed-unread-context {
    display: none;
  }

  .feed-health.has-error {
    color: var(--danger);
    font-weight: 600;
  }

  .feed-health.is-checking {
    color: var(--accent);
  }

  .btn-feed-delete {
    position: relative;
    width: 40px;
    height: 40px;
    padding: 0;
    color: var(--muted);
  }

  .btn-feed-delete :global(.feed-delete-icon) {
    position: absolute;
    width: 16px;
    height: 16px;
    transition:
      opacity 120ms ease,
      transform 140ms cubic-bezier(0.2, 0, 0, 1);
  }

  .btn-feed-delete :global(.feed-delete-icon-confirm) {
    opacity: 0;
    transform: scale(0.7);
  }

  .btn-feed-delete:hover {
    color: var(--danger);
  }

  .btn-feed-delete.is-confirming {
    color: var(--accent-foreground);
    background: var(--danger);
    border-color: var(--danger);
  }

  .btn-feed-delete.is-confirming :global(.feed-delete-icon-idle) {
    opacity: 0;
    transform: scale(0.7);
  }

  .btn-feed-delete.is-confirming :global(.feed-delete-icon-confirm) {
    opacity: 1;
    transform: scale(1);
  }

  .feed-delete-spinner {
    position: absolute;
    width: 14px;
    height: 14px;
    border: 2px solid color-mix(in srgb, var(--accent-foreground) 30%, transparent);
    border-top-color: var(--accent-foreground);
    border-radius: 50%;
    opacity: 0;
  }

  .btn-feed-delete.is-deleting :global(.feed-delete-icon) {
    opacity: 0;
    transform: scale(0.7);
  }

  .btn-feed-delete.is-deleting .feed-delete-spinner {
    opacity: 1;
    animation: feed-spin 700ms linear infinite;
  }

  @keyframes feed-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 699px) {
    .feed-item {
      grid-template-columns: minmax(0, 1fr) 44px;
      align-items: center;
      gap: 2px var(--spacing-xs);
      min-height: 64px;
      padding: 8px var(--spacing-md);
    }

    .feed-label {
      line-height: 1.25;
    }

    .feed-meta {
      font-size: 0.76em;
    }

    .feed-info {
      min-width: 0;
    }

    .feed-metrics {
      display: flex;
      grid-column: 1;
      gap: var(--spacing-sm);
      justify-content: flex-start;
      text-align: left;
    }

    .feed-health {
      order: 1;
    }

    .feed-unread {
      order: 2;
    }

    .btn-feed-delete {
      grid-column: 2;
      grid-row: 1 / span 2;
      width: 44px;
      height: 44px;
    }

    .feed-unread-context {
      display: inline;
    }

    .feed-unread:not(.has-unread) {
      display: none;
    }

    .feed-pending {
      grid-template-columns: minmax(0, 1fr) 44px;
      min-height: 64px;
      padding: 8px var(--spacing-md);
    }

    .feed-pending-metrics {
      grid-column: 1;
    }

    .feed-pending-action {
      grid-column: 2;
      grid-row: 1 / span 2;
      width: 44px;
      height: 44px;
    }
  }
</style>
