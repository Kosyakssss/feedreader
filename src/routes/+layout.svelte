<script lang="ts">
  import { onMount, setContext, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { Reader, readerKey } from '$lib/client/reader.svelte';
  import { faviconDataUri } from '$lib/icons';
  import Navigation from '$lib/components/Navigation.svelte';
  import ShortcutsDialog from '$lib/components/ShortcutsDialog.svelte';
  import Toasts from '$lib/components/Toasts.svelte';
  import '../app.css';
  let { children, data } = $props();
  const reader = setContext(readerKey, new Reader(untrack(() => data.initial)));
  let shortcuts = $state<{ toggle(): void }>();
  onMount(() => {
    reader.start();
    return () => reader.stop();
  });
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
    const dialogOpen = document.querySelector('dialog[open]');
    if (event.key === '?') {
      shortcuts?.toggle();
      event.preventDefault();
    } else if (!dialogOpen && ['1', '2', '3', '4'].includes(event.key)) {
      const routes = ['/', '/starred', '/feeds', '/settings'];
      void goto(base + routes[Number(event.key) - 1]);
      event.preventDefault();
    } else if (event.key.toLowerCase() === 'r' && !dialogOpen) {
      void reader.refresh(true);
      event.preventDefault();
    }
  }
</script>

<svelte:head>
  <title>Feedreader</title><link rel="icon" href={faviconDataUri()} />
  <link
    id="theme-link"
    rel="stylesheet"
    href={`${base}/api/theme/${encodeURIComponent(reader.config.theme)}.css?appearance=${reader.config.appearance}`}
  />
</svelte:head>
<svelte:document onkeydown={keydown} onvisibilitychange={() => reader.resume()} />
<svelte:window
  onpageshow={() => reader.resume()}
  ononline={() => reader.resume()}
  onfocus={() => reader.resume()}
/>
<Navigation />
<main id="app">{@render children()}</main>
<ShortcutsDialog bind:this={shortcuts} />
<Toasts />
