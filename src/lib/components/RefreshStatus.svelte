<script lang="ts">
  import { onDestroy } from 'svelte';
  import { useReader } from '$lib/client/reader.svelte';
  const reader = useReader();
  let segments = $state(0),
    phase = $state('loading'),
    revealed = $state(false),
    seenRun: string | null = null;
  const status = $derived(reader.status);
  const failures = $derived(status ? Math.max(status.failed, status.failures.length) : 0);
  const outcome = $derived(
    status?.error || (status && status.total > 0 && failures >= status.total)
      ? 'failed'
      : failures
        ? 'warning'
        : 'complete',
  );
  const label = $derived(
    outcome === 'failed'
      ? 'All feeds failed'
      : failures
        ? `${failures} ${failures === 1 ? 'feed' : 'feeds'} failing`
        : 'All refreshed',
  );
  const live = $derived(
    !reader.complete && reader.syncing
      ? 'Loading saved entries…'
      : status?.refreshing
        ? `Checking feeds ${status.completed}/${status.total}${status.count ? ` · ${status.count} new` : ''}`
        : status?.error
          ? 'Refresh failed'
          : `${status?.count ? `${status.count} new` : 'Up to date'}${failures ? ` · ${failures} failed` : ''}`,
  );
  const runId = $derived(status?.runId);
  $effect(() => {
    const run = runId;
    if (!run || run === seenRun) return;
    const initial = seenRun === null;
    seenRun = run;
    if (initial && !status?.refreshing) {
      segments = 4;
      phase = `${outcome}-collapsed`;
      return;
    }
    segments = 0;
    phase = 'resetting';
    revealed = false;
    reader.setRefreshAnimation(true);
    const timer = setTimeout(() => (phase = 'running'), 0);
    return () => clearTimeout(timer);
  });
  $effect(() => {
    if (!status || phase === 'resetting' || phase.endsWith('collapsed')) return;
    const confirmed = status.refreshing
      ? status.total
        ? Math.floor((4 * status.completed) / status.total)
        : 0
      : 4;
    if (segments < confirmed) {
      const timer = setTimeout(() => segments++, 320);
      return () => clearTimeout(timer);
    }
    if (!status.refreshing && segments === 4) {
      phase = outcome;
      const timer = setTimeout(() => (phase = `${outcome}-collapsed`), 700);
      return () => clearTimeout(timer);
    }
  });
  $effect(() => {
    if (!phase.endsWith('collapsed')) return;
    const timer = setTimeout(() => reader.setRefreshAnimation(false), 240);
    return () => clearTimeout(timer);
  });
  onDestroy(() => reader.setRefreshAnimation(false));
</script>

<svelte:document
  onpointerdown={(event) => {
    if (!(event.target instanceof Element) || !event.target.closest('[data-refresh-status]'))
      revealed = false;
  }}
/>
<button
  class="refresh-status"
  id="refresh-status"
  type="button"
  data-refresh-status
  data-phase={!reader.complete && reader.syncing ? 'loading' : status ? phase : 'idle'}
  data-revealed={revealed}
  aria-label={status?.refreshing ? live : label}
  aria-expanded={revealed}
  title={status?.failures.map((failure) => `${failure.label}: ${failure.error}`).join('\n') || ''}
  onclick={() => {
    if (phase.endsWith('collapsed')) revealed = !revealed;
  }}
>
  <span class="refresh-label">{label}</span>
  <span
    class="refresh-graphic"
    role={phase === 'running' ? 'progressbar' : undefined}
    aria-hidden={phase !== 'running' ? true : undefined}
    aria-label={phase === 'running' ? 'Feed refresh' : undefined}
    aria-valuemin={phase === 'running' ? 0 : undefined}
    aria-valuemax={phase === 'running' ? status?.total : undefined}
    aria-valuenow={phase === 'running' ? status?.completed : undefined}
  >
    {#each [0, 1, 2, 3] as index}<span
        class="refresh-bar"
        class:is-filled={index < segments}
        class:is-active={index === segments && phase === 'running'}
      ></span>{/each}
  </span>
  <span class="visually-hidden" role="status" aria-live="polite">{live}</span>
</button>

<style>
  .refresh-status {
    margin-left: auto;
    white-space: nowrap;
  }

  .refresh-status {
    --refresh-segment-width: 28px;
    --refresh-inline-padding: 0px;
    appearance: none;
    position: relative;
    display: flex;
    width: 140px;
    align-self: stretch;
    align-items: center;
    justify-content: flex-end;
    gap: 0;
    padding: 0 var(--refresh-inline-padding);
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--muted);
    cursor: default;
    font-family: var(--font-sans);
    font-size: 0.8em;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .refresh-graphic {
    display: flex;
    width: calc(var(--refresh-segment-width) * 4 + 12px);
    flex: none;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
    transition:
      width 240ms cubic-bezier(0.16, 1, 0.3, 1),
      gap 240ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  .refresh-bar {
    position: relative;
    overflow: hidden;
    width: var(--refresh-segment-width);
    height: 4px;
    flex: none;
    border-radius: 999px;
    background: var(--border);
    transform-origin: center;
    transition:
      width 240ms cubic-bezier(0.16, 1, 0.3, 1),
      opacity 160ms ease;
  }

  .refresh-bar::before {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--muted);
    content: '';
    transform: scaleX(0);
    transform-origin: left center;
    transition: background-color 140ms ease;
  }

  .refresh-bar.is-active::before {
    animation: refresh-bar-scan 320ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }

  @keyframes refresh-bar-scan {
    to {
      transform: scaleX(1);
    }
  }

  .refresh-bar.is-filled {
    background: var(--border);
  }

  .refresh-bar.is-filled::before,
  .refresh-status[data-phase='complete'] .refresh-bar.is-filled::before,
  .refresh-status[data-phase='complete-collapsed'] .refresh-bar:first-child::before {
    background: var(--accent);
    transform: scaleX(1);
  }

  .refresh-status[data-phase='warning'] .refresh-bar.is-filled::before,
  .refresh-status[data-phase='warning-collapsed'] .refresh-bar:first-child::before {
    background: var(--warning);
  }

  .refresh-status[data-phase='failed'] .refresh-bar.is-filled::before,
  .refresh-status[data-phase='failed-collapsed'] .refresh-bar:first-child::before {
    background: var(--danger);
  }

  .refresh-status:is(
      [data-phase='idle'],
      [data-phase='loading'],
      [data-phase='resetting'],
      [data-phase$='-collapsed']
    )
    .refresh-graphic {
    width: var(--refresh-segment-width);
    gap: 0;
  }

  .refresh-status:is(
      [data-phase='idle'],
      [data-phase='loading'],
      [data-phase='resetting'],
      [data-phase$='-collapsed']
    )
    .refresh-bar:not(:first-child) {
    width: 0;
    opacity: 0;
  }

  .refresh-status[data-phase='idle'] .refresh-bar:first-child,
  .refresh-status[data-phase='loading'] .refresh-bar:first-child {
    background: var(--border);
  }

  .refresh-label {
    position: absolute;
    top: 50%;
    right: calc(var(--refresh-inline-padding) + var(--refresh-segment-width) + 7px);
    width: max-content;
    max-width: 12rem;
    overflow: hidden;
    opacity: 0;
    text-overflow: ellipsis;
    pointer-events: none;
    transform: translate(3px, -50%);
    transition:
      opacity 140ms ease,
      transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
    white-space: nowrap;
  }

  .refresh-status[data-phase$='-collapsed'] {
    cursor: pointer;
  }

  .refresh-status[data-phase$='-collapsed']:is(:hover, :focus-visible) .refresh-label,
  .refresh-status[data-phase$='-collapsed'][data-revealed='true'] .refresh-label {
    opacity: 1;
    transform: translate(0, -50%);
  }

  @media (prefers-reduced-motion: reduce) {
    .refresh-graphic,
    .refresh-bar,
    .refresh-bar::before,
    .refresh-label {
      transition: none;
    }

    .refresh-bar.is-active::before {
      animation: none;
      transform: scaleX(1);
    }
  }

  @media (max-width: 699px) {
    .refresh-status {
      --refresh-segment-width: 28px;
      --refresh-inline-padding: 4px;
      width: 140px;
      flex: none;
      margin-left: 0;
      margin-right: 8px;
    }

    .refresh-label {
      min-width: 0;
    }
  }
</style>
