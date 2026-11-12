<script lang="ts">
  import '../app.css';
  import { flushSync } from 'svelte';
  import { onNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import Crumbs from '#lib/components/Crumbs.svelte';
  import Search from '#lib/components/Search.svelte';
  import SearchIcon from '#lib/components/SearchIcon.svelte';
  import { cards } from '#lib/cards.svelte.ts';
  import { popups } from '#lib/popups.svelte.ts';
  import { trailFor } from '#lib/trail.ts';
  import type { LayoutProps } from './$types';

  let { data, children }: LayoutProps = $props();

  const trail = $derived(trailFor(page.url.pathname, data.feeds));
  let search: Search;

  // Focused in the same press that opens it, or a phone won't show its keyboard.
  function toggleSearch(): void {
    popups.toggle('search');
    flushSync();
    if (popups.isOpen('search')) search.focus();
  }

  // A phone's keyboard covers the bottom of the window without making it any
  // shorter, so search's results would run on under it. This is how much is
  // still visible, at the page's own zoom, so pinching doesn't change it.
  $effect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () =>
      document.documentElement.style.setProperty('--visible-height', `${viewport.height * viewport.scale}px`);
    update();
    viewport.addEventListener('resize', update);
    return () => viewport.removeEventListener('resize', update);
  });

  // Pressing anywhere but a menu's names, or search, closes an open popup, and
  // so does Escape. A menu's empty space counts as outside it.
  function pressed(event: MouseEvent): void {
    const target = event.target as Element;
    if (!popups.anyOpen || target.closest('#search, .menu a, [data-popup-toggle]')) return;
    popups.close();
  }

  function key(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !popups.anyOpen) return;
    event.preventDefault();
    popups.close();
  }

  // Changing page crossfades the whole page, open popup and all.
  onNavigate((navigation) => {
    cards.close();
    if (!document.startViewTransition) return popups.reset();
    return new Promise((resolve) => {
      document.startViewTransition({
        update: async () => {
          popups.reset();
          resolve();
          await navigation.complete;
        },
        types: ['page-change'],
      });
    });
  });
</script>

<!-- Safari on a phone shows a press (:active) only on a page that listens for touches. -->
<svelte:document onclick={pressed} onkeydown={key} ontouchstart={() => {}} />

<div class="header-glass"></div>
<header>
  <Crumbs {trail} />
  <button class="icon" aria-label="Search" data-popup-toggle onclick={toggleSearch}>
    <SearchIcon />
  </button>
</header>

<div class="veil"></div>
<Search bind:this={search} />

<main>
  {@render children()}
</main>
