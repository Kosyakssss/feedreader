<script lang="ts">
  import '../app.css';
  import { flushSync, onMount } from 'svelte';
  import { goto, onNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import Crumbs from '#lib/components/Crumbs.svelte';
  import Search from '#lib/components/Search.svelte';
  import SearchIcon from '#lib/components/SearchIcon.svelte';
  import { cards } from '#lib/cards.svelte.ts';
  import { virtualKeyboard } from '#lib/keyboard.ts';
  import { library } from '#lib/library.svelte.ts';
  import { popups } from '#lib/popups.svelte.ts';
  import { feedPath } from '#lib/format.ts';
  import { trailFor } from '#lib/trail.ts';
  import type { LayoutProps } from './$types';

  let { data, children }: LayoutProps = $props();

  // Where in the app this page is, whatever path the app itself is served under.
  const here = $derived(page.route.id === '/feed/[id]' ? feedPath(Number(page.params.id)) : (page.route.id ?? '/'));
  const trail = $derived(trailFor(here, library.ready ? library.sources : data.feeds));

  // The whole library comes to the device as the app starts, and stays current.
  onMount(() => library.start());
  let search: Search;

  // Focused in the same press that opens it, or a phone won't show its keyboard.
  function toggleSearch(): void {
    popups.toggle('search');
    flushSync();
    if (popups.isOpen('search')) search.focus();
  }

  // A phone's keyboard covers the bottom of the window without making it any
  // shorter, so search would run on under it. This is how much is still
  // visible, at the page's own zoom so pinching doesn't change it, and how far
  // Safari has slid the page up to show a field.
  $effect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      document.documentElement.style.setProperty('--visible-height', `${viewport.height * viewport.scale}px`);
      document.documentElement.style.setProperty('--visible-top', `${viewport.offsetTop}px`); // where Safari has slid the page to
      // The keyboard covers the window's bottom without making it shorter.
      // Chrome counts innerHeight to the keyboard, so the window's height is
      // taken from the page's box instead. A keyboard laid over the page
      // shrinks nothing, and says itself how tall it is.
      const over = keyboard?.overlaysContent ? keyboard.boundingRect.height : 0;
      const shrunk = Math.max(0, document.documentElement.clientHeight - viewport.height * viewport.scale);
      document.documentElement.style.setProperty('--keyboard-over', `${over}px`);
      document.documentElement.toggleAttribute('data-keyboard-over', !!keyboard?.overlaysContent);
      document.documentElement.style.setProperty('--keyboard', `${shrunk + over}px`);
    };
    const keyboard = virtualKeyboard();
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    keyboard?.addEventListener('geometrychange', update);
    return () => {
      keyboard?.removeEventListener('geometrychange', update);
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  });

  // Pressing anywhere but a menu's names, or search, closes an open popup, and
  // so does Escape. A menu's empty space counts as outside it.
  function pressed(event: MouseEvent): void {
    const target = event.target as Element;
    if (!popups.anyOpen || target.closest('#search, .menu a, [data-popup-toggle]')) return;
    popups.close();
  }

  // Back closes an open popup: the history has moved off its step.
  let shown: number | undefined;
  $effect(() => {
    const now = page.state.popup;
    if (shown !== undefined && shown === popups.step && now !== shown) popups.left();
    shown = now;
  });

  // A step left over from before a reload has no popup open on it any more.
  onMount(() => {
    if (page.state.popup) goto(page.url.href, { state: {}, shallow: true, replace: true });
  });

  // A page opened from a popup takes the popup's step in the history.
  function follow(event: MouseEvent): void {
    if (!popups.step || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element).closest('.popup a[href]');
    if (!(link instanceof HTMLAnchorElement) || link.target || link.origin !== location.origin) return;
    event.preventDefault();
    popups.visit(link.href);
  }

  // A double click on what can't be selected selects nothing. Safari otherwise
  // reaches past it for the nearest words it can select, or the space
  // between rows.
  function unselectable(event: MouseEvent): void {
    if (event.detail < 2 || !(event.target instanceof Element)) return;
    const style = getComputedStyle(event.target);
    if ((style.userSelect || style.webkitUserSelect) === 'none') event.preventDefault();
  }

  function key(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !popups.anyOpen) return;
    event.preventDefault();
    popups.close();
  }

  // Changing page crossfades the whole page, open popup and all. Browsers
  // without transition types (Safari before 18.2) would refuse the options, so
  // they change page without it.
  const crossfades = typeof ViewTransition !== 'undefined' && 'types' in ViewTransition.prototype;

  // Opening a popup and Back from it are shallow: the page stays.
  onNavigate((navigation) => {
    if (navigation.shallow) return;
    cards.close();
    if (!crossfades) return popups.reset();
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
<svelte:document
  onclickcapture={follow}
  onclick={pressed}
  onmousedown={unselectable}
  onkeydown={key}
  ontouchstart={() => {}}
/>

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
