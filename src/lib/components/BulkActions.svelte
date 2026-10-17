<script lang="ts">
  import { useReader } from '$lib/client/reader.svelte';
  import type { Selection } from '$lib/client/selection.svelte';
  import Icon from './Icon.svelte';
  let { selection }: { selection: Selection } = $props();
  const reader = useReader();
  async function perform(action: 'read' | 'unread' | 'open' | 'star' | 'cancel') {
    const entries = reader.entries.filter((entry) => selection.ids.has(entry.id));
    if (action === 'open') await reader.openMany(entries, 'selected');
    else if (action !== 'cancel')
      await reader.mark(
        entries.map((entry) => entry.id),
        action === 'star' ? { starred: true } : { read: action === 'read' },
      );
    selection.clear();
  }
</script>

{#if selection.ids.size}<div class="bulk-bar" id="bulk-bar">
    <span class="bulk-count">{selection.ids.size} selected</span>
    <button class="btn" onclick={() => perform('read')}>Mark read</button>
    <button class="btn" onclick={() => perform('unread')}>Mark unread</button>
    <button class="btn" onclick={() => perform('open')}
      >Open<Icon name="external-link" class="ui-icon button-icon" /></button
    >
    <button class="btn" onclick={() => perform('star')}
      ><Icon name="star" class="ui-icon button-icon" />Star</button
    >
    <button class="btn" id="bulk-cancel" onclick={() => perform('cancel')}>Cancel</button>
  </div>{/if}

<style>
  .bulk-bar {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--spacing-sm);
    padding: var(--spacing-sm) var(--spacing-md);
  }

  .bulk-bar {
    background: var(--navigation-background);
    border-top: 0.5px solid var(--border);
    backdrop-filter: saturate(180%) blur(20px);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
  }

  .bulk-count {
    font-size: 0.9em;
    color: var(--muted);
    font-weight: 500;
  }

  @media (max-width: 699px) {
    .bulk-bar {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--spacing-xs);
      justify-content: stretch;
      padding: var(--spacing-sm) var(--spacing-sm) calc(var(--spacing-sm) + env(safe-area-inset-bottom));
      text-align: center;
    }

    .bulk-count {
      grid-column: 1 / -1;
    }

    .bulk-bar .btn {
      width: 100%;
    }

    #bulk-cancel {
      grid-column: 1 / -1;
    }
  }
</style>
