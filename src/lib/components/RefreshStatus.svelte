<script lang="ts">
  import { useReader } from '$lib/client/reader.svelte';
  const reader = useReader();
  let segments = $state(0),
    phase = $state('loading'),
    revealed = $state(false);
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
    reader.loading
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
    if (!run) return;
    segments = 0;
    phase = 'resetting';
    revealed = false;
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
  data-phase={reader.loading ? 'loading' : status ? phase : 'idle'}
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
