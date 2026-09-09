<script lang="ts">
  import { onMount, setContext, untrack } from 'svelte';
  import { page } from '$app/state';
  import { afterNavigate } from '$app/navigation';
  import { toastOut } from '$lib/client/motion';
  import { Reader, readerKey } from '$lib/client/reader.svelte';
  import { internalPath } from '$lib/client/paths';
  import { faviconDataUri } from '$lib/icons';
  import Icon from '$lib/components/Icon.svelte';
  import RefreshStatus from '$lib/components/RefreshStatus.svelte';
  import '$lib/styles/theme.css';
  import '$lib/styles/index.css';
  let { children, data } = $props();
  const reader = setContext(readerKey, new Reader(untrack(() => data.initial)));
  let menu = $state(false),
    shortcuts = $state(false),
    closeButton = $state<HTMLButtonElement>(),
    returnFocus: HTMLElement | null = null;
  const path = $derived(internalPath(page.url.pathname));
  const links = [
    ['/', 'Timeline'],
    ['/starred', 'Starred'],
    ['/feeds', 'Feeds'],
    ['/settings', 'Settings'],
  ];
  const keys = [
    ['j', 'Next entry'],
    ['k', 'Previous entry'],
    ['o', 'Open entry'],
    ['m', 'Toggle read'],
    ['s', 'Toggle star'],
    ['x', 'Toggle select'],
    ['a', 'Mark all read'],
    ['r', 'Refresh feeds'],
    ['?', 'Show shortcuts'],
    ['Esc', 'Close / clear'],
  ];
  onMount(() => {
    void reader.start();
    const media = matchMedia('(max-width: 699px)');
    const close = () => (menu = false);
    media.addEventListener('change', close);
    return () => {
      reader.stop();
      media.removeEventListener('change', close);
    };
  });
  afterNavigate(() => (menu = false));
  $effect(() => {
    document.body.classList.toggle('nav-menu-open', menu);
  });
  $effect(() => {
    if (shortcuts) closeButton?.focus({ preventScroll: true });
  });
  function toggleShortcuts(open: boolean) {
    if (open) returnFocus = document.activeElement as HTMLElement;
    shortcuts = open;
    if (!open && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  function keydown(event: KeyboardEvent) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const active = document.activeElement;
    if (active instanceof Element && active.matches('input,textarea,select,[contenteditable=true]')) {
      if (event.key === 'Escape' && active instanceof HTMLElement) {
        active.blur();
        event.preventDefault();
      }
      return;
    }
    if (event.key === '?') {
      toggleShortcuts(!shortcuts);
      event.preventDefault();
    } else if (event.key === 'Escape' && (shortcuts || menu)) {
      if (shortcuts) toggleShortcuts(false);
      else menu = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    } else if (event.key.toLowerCase() === 'r') {
      void reader.refresh(true);
      event.preventDefault();
    } else if (event.key === 'Tab' && shortcuts) {
      event.preventDefault();
      closeButton?.focus();
    }
  }
</script>

<svelte:head
  ><title>Feedreader</title><link rel="icon" href={faviconDataUri()} /><link
    id="theme-link"
    rel="stylesheet"
    href={`${reader.path('/api/theme')}?config=${encodeURIComponent(JSON.stringify(reader.config))}`}
  /></svelte:head
>
<svelte:document onkeydown={keydown} onvisibilitychange={() => reader.resume()} />
<svelte:window onpageshow={() => reader.resume()} ononline={() => reader.resume()} />
<nav class="nav-bar">
  <a href={reader.path('/')} class="nav-logo"
    ><Icon name="bookmark" class="ui-icon nav-logo-icon" /><span>Feedreader</span></a
  >
  <RefreshStatus />
  <button
    class="nav-menu-button"
    type="button"
    aria-label={menu ? 'Close navigation' : 'Open navigation'}
    aria-expanded={menu}
    onclick={() => (menu = !menu)}><Icon name="menu" /></button
  >
  <div class="nav-links">
    {#each links as [href, label]}<a
        href={reader.path(href!)}
        class="nav-link"
        class:active={path === href}
        aria-current={path === href ? 'page' : undefined}>{label}</a
      >{/each}
  </div>
</nav>
{#if menu}<button class="nav-scrim" aria-label="Close navigation" onclick={() => (menu = false)}
  ></button>{/if}
<main id="app">{@render children()}</main>
{#if shortcuts}<div
    class="shortcuts-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="shortcuts-title"
    tabindex="-1"
    data-shortcuts-open
  >
    <div class="shortcuts-panel">
      <h2 id="shortcuts-title">Keyboard Shortcuts</h2>
      <div class="shortcuts-grid">
        {#each keys as [key, label]}<kbd>{key}</kbd><span>{label}</span>{/each}
      </div>
      <button class="btn" bind:this={closeButton} onclick={() => toggleShortcuts(false)}>Close</button>
    </div>
  </div>{/if}
<div class="toast-container" role="status" aria-live="polite" aria-atomic="true">
  {#each reader.toasts as toast (toast.id)}<div class="toast" out:toastOut>
      {toast.message}
    </div>{/each}
</div>
