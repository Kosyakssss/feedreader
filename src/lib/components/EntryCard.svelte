<script lang="ts">
  import type { EnrichedEntry } from '$lib/types';
  import type { Selection } from '$lib/client/selection.svelte';
  import { useReader } from '$lib/client/reader.svelte';
  import { safeHttpUrl, timeAgo } from '$lib/client/entries';
  import { revealContent } from '$lib/client/motion';
  import Icon from './Icon.svelte';
  let {
    entry,
    index,
    selection,
    active = false,
    delay = 0,
  }: {
    entry: EnrichedEntry;
    index: number;
    selection: Selection;
    active?: boolean;
    delay?: number;
  } = $props();
  const reader = useReader();
  const href = $derived(safeHttpUrl(entry.url));
</script>

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
  <label class="entry-checkbox" onpointerdown={(event) => selection.down(event, entry.id, index)}>
    <input
      type="checkbox"
      aria-label={`Select ${entry.title || 'entry'}`}
      checked={selection.ids.has(entry.id)}
      onclick={(event) => {
        if (selection.suppressClick) event.preventDefault();
        else selection.toggle(entry.id, index, event.shiftKey);
      }}
    />
  </label>
  <div class="entry-content">
    {#if href}<a
        class="entry-title"
        dir="auto"
        {href}
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
    <span class="entry-meta" dir="auto">{entry.feedLabel || 'Unknown'} · {timeAgo(entry.published)}</span>
  </div>
  <div class="entry-actions">
    <button
      class="btn-icon btn-star"
      class:starred={entry.state.starred}
      aria-pressed={!!entry.state.starred}
      title={entry.state.starred ? 'Unstar' : 'Star'}
      aria-label="Star entry"
      onclick={() => reader.toggle(entry.id, 'starred')}
    >
      <Icon name={entry.state.starred ? 'star-filled' : 'star'} />
    </button>
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

<style>
  .entry-card {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    cursor: default;
  }

  .entry-checkbox {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .entry-content {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 2px;
  }

  .entry-title {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .entry-actions {
    display: flex;
    flex-shrink: 0;
    gap: var(--spacing-xs);
  }

  .entry-actions .btn-icon {
    width: 40px;
    height: 40px;
    flex: none;
    padding: 0;
  }

  .btn-star.starred {
    color: var(--star-accent);
  }

  .btn-star.starred:hover {
    color: var(--star-accent);
  }

  .entry-card {
    background: var(--surface);
    border: 0.5px solid var(--border);
    border-radius: 0;
    padding: var(--spacing-sm) var(--spacing-md);
    transition: none;
    user-select: none;
  }

  .entry-card:hover {
    background: var(--surface-hover);
    z-index: 1;
    position: relative;
  }

  .entry-read {
    opacity: 0.45;
  }

  .entry-read:hover {
    opacity: 0.75;
  }

  .entry-selected {
    background: var(--accent-soft);
    box-shadow: inset 3px 0 0 var(--accent);
    opacity: 1;
  }

  .entry-selected:hover {
    background: var(--accent-soft-hover);
    opacity: 1;
  }

  .entry-focused {
    background: var(--surface-hover);
    outline: none;
    z-index: 2;
    position: relative;
    transition: none;
  }

  .entry-read.entry-focused {
    opacity: 0.75;
  }

  .entry-title {
    color: var(--link);
    text-decoration: none;
    font-weight: 500;
    font-size: 0.95em;
    line-height: 1.4;
    letter-spacing: -0.01em;
  }

  .entry-title:hover {
    color: var(--accent);
    text-decoration: none;
  }

  .entry-unread .entry-title {
    font-weight: 600;
  }

  .entry-meta {
    color: var(--muted);
    font-size: 0.8em;
  }

  .entry-checkbox input[type='checkbox'] {
    -webkit-appearance: none;
    appearance: none;
    width: 18px;
    height: 18px;
    border: 1.5px solid var(--border);
    border-radius: 0;
    cursor: pointer;
    position: relative;
    transform-origin: center;
    transition:
      background var(--duration-default),
      border-color var(--duration-default),
      transform 80ms ease-out;
    flex-shrink: 0;
    touch-action: none;
  }

  .entry-checkbox {
    touch-action: none;
  }

  .entry-checkbox:active input[type='checkbox'] {
    transform: scale(0.9);
  }

  .entry-checkbox input[type='checkbox']:hover {
    border-color: var(--accent);
  }

  .entry-checkbox input[type='checkbox']:checked {
    background: var(--accent);
    border-color: var(--accent);
  }

  @media (prefers-reduced-motion: reduce) {
    .entry-checkbox input[type='checkbox'] {
      transition: none;
    }

    .entry-checkbox:active input[type='checkbox'] {
      transform: none;
    }
  }

  @media (max-width: 699px) {
    .entry-card {
      padding: var(--spacing-sm) var(--spacing-sm);
    }

    .entry-actions {
      gap: 0;
    }

    .entry-actions .btn-icon {
      width: 44px;
      height: 44px;
    }

    .entry-checkbox input[type='checkbox'] {
      width: 18px;
      height: 18px;
    }

    .entry-checkbox {
      width: 44px;
      height: 44px;
      margin: -13px;
      padding: 13px;
      cursor: pointer;
      justify-content: center;
    }
  }
</style>
