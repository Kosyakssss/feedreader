<script lang="ts">
  import { page } from '$app/state';
  import { base } from '$app/paths';
  let dialog = $state<HTMLDialogElement>();
  const navigation = [
    ['1', 'Timeline'],
    ['2', 'Starred'],
    ['3', 'Feeds'],
    ['4', 'Settings'],
  ];
  const entries = [
    ['j', 'Next entry'],
    ['k', 'Previous entry'],
    ['o', 'Open entry'],
    ['m', 'Toggle read'],
    ['s', 'Toggle star'],
    ['x', 'Toggle select'],
    ['a', 'Mark all read'],
  ];
  const feeds = [
    ['j', 'Next feed'],
    ['k', 'Previous feed'],
    ['Shift+j/k', 'Last / first feed'],
    ['o / Enter', 'Open feed'],
    ['a', 'Add feed'],
    ['d', 'Remove feed'],
    ['i', 'Import OPML'],
    ['e', 'Export OPML'],
  ];
  const common = [
    ['r', 'Refresh feeds'],
    ['?', 'Show shortcuts'],
    ['Esc', 'Close / clear'],
  ];
  const keys = $derived([
    ...navigation,
    ...(page.url.pathname === `${base}/feeds`
      ? feeds
      : page.url.pathname === `${base}/` ||
          page.url.pathname === `${base}/starred` ||
          page.url.pathname.startsWith(`${base}/feed/`)
        ? entries
        : []),
    ...common,
  ]);
  export function toggle(): void {
    if (dialog?.open) dialog.close();
    else dialog?.showModal();
  }
</script>

<dialog class="shortcuts-panel" bind:this={dialog} aria-labelledby="shortcuts-title">
  <h2 id="shortcuts-title">Keyboard Shortcuts</h2>
  <div class="shortcuts-grid">
    {#each keys as [key, label]}<kbd>{key}</kbd><span>{label}</span>{/each}
  </div>
  <form method="dialog"><button class="btn">Close</button></form>
</dialog>

<style>
  .shortcuts-grid {
    display: grid;
    align-items: center;
    grid-template-columns: auto 1fr;
    gap: var(--spacing-xs) var(--spacing-md);
    margin-bottom: var(--spacing-md);
  }

  .shortcuts-panel {
    background: var(--surface);
    border: 0.5px solid var(--border);
    border-radius: 0;
    box-shadow: 0 8px 40px var(--shadow);
    padding: var(--spacing-xl);
    max-width: 420px;
    width: 90%;
  }

  .shortcuts-panel h2 {
    font-size: 1.1em;
    font-weight: 600;
    margin-bottom: var(--spacing-md);
    color: var(--foreground);
  }

  .shortcuts-panel kbd {
    display: inline-block;
    background: var(--surface-hover);
    border: 0.5px solid var(--border);
    border-radius: 0;
    padding: 3px 8px;
    font-family: var(--font-mono);
    font-size: 0.8em;
    min-width: 28px;
    text-align: center;
    box-shadow: 0 1px 0 var(--shadow-faint);
  }

  .shortcuts-panel span {
    color: var(--muted);
    font-size: 0.9em;
  }

  @media (max-width: 699px) {
    .shortcuts-panel {
      padding: var(--spacing-md);
    }
  }

  .shortcuts-panel {
    margin: auto;
    color: var(--foreground);
  }
  .shortcuts-panel::backdrop {
    background: var(--scrim);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
</style>
