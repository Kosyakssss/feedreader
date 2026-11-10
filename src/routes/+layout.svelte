<script lang="ts">
  import '../app.css';
  import { flushSync } from 'svelte';
  import { onNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import Crumbs from '#lib/components/Crumbs.svelte';
  import Search from '#lib/components/Search.svelte';
  import SearchIcon from '#lib/components/SearchIcon.svelte';
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

  // Pressing anywhere outside an open popup closes it, and so does Escape.
  function pressed(event: MouseEvent): void {
    if (popups.anyOpen && !(event.target as Element).closest('.popup, [data-popup-toggle]')) popups.close();
  }

  function key(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !popups.anyOpen) return;
    event.preventDefault();
    popups.close();
  }

  // Changing page crossfades the whole page, open popup and all.
  onNavigate((navigation) => {
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

<svelte:document onclick={pressed} onkeydown={key} />

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
