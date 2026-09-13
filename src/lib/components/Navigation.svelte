<script lang="ts">
  import { page } from '$app/state';
  import { base } from '$app/paths';
  import { afterNavigate } from '$app/navigation';
  import { MediaQuery } from 'svelte/reactivity';
  import Icon from './Icon.svelte';
  import RefreshStatus from './RefreshStatus.svelte';
  let menu = $state(false);
  const mobile = new MediaQuery('(max-width: 699px)');
  const links = [
    ['/', 'Timeline'],
    ['/starred', 'Starred'],
    ['/feeds', 'Feeds'],
    ['/settings', 'Settings'],
  ];
  afterNavigate(() => (menu = false));
  $effect(() => {
    if (!mobile.current) menu = false;
  });
  $effect(() => {
    document.body.classList.toggle('nav-menu-open', menu);
    return () => document.body.classList.remove('nav-menu-open');
  });
</script>

<svelte:document
  onkeydown={(event) => {
    if (event.key === 'Escape' && menu) {
      menu = false;
      event.preventDefault();
    }
  }}
/>
<nav class="nav-bar">
  <a href={`${base}/`} class="nav-logo"
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
  <div class="nav-links" class:open={menu}>
    {#each links as [href, label]}<a
        href={base + href!}
        class="nav-link"
        class:active={page.url.pathname === base + href}
        aria-current={page.url.pathname === base + href ? 'page' : undefined}>{label}</a
      >{/each}
  </div>
</nav>
{#if menu}<button class="nav-scrim" aria-label="Close navigation" onclick={() => (menu = false)}
  ></button>{/if}

<style>
  .nav-bar {
    position: sticky;
    top: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    min-height: 46px;
    justify-content: space-between;
    padding: 0 var(--spacing-md);
    gap: var(--spacing-md);
  }

  .nav-links {
    display: flex;
    gap: var(--spacing-xs);
  }

  .nav-menu-button {
    display: none;
  }

  .nav-scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
  }

  .nav-bar {
    background: var(--navigation-background);
    border-bottom: 0.5px solid var(--border);
    backdrop-filter: saturate(180%) blur(20px);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
  }

  .nav-logo {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-weight: 600;
    color: var(--foreground);
    text-decoration: none;
    font-size: 1.05em;
    letter-spacing: -0.02em;
  }

  .nav-link {
    color: var(--muted);
    text-decoration: none;
    font-size: 0.9em;
    font-weight: 500;
    padding: var(--spacing-xs) var(--spacing-sm);
    border-radius: 0;
    transition: color var(--duration-default);
  }

  .nav-link:hover {
    color: var(--foreground);
  }

  .nav-link.active {
    color: var(--accent);
    font-weight: 600;
  }

  .nav-menu-button {
    background: var(--surface);
    border: 0.5px solid var(--border);
    border-radius: 0;
    color: var(--foreground);
    cursor: pointer;
    font-family: var(--font-sans);
    font-size: 1.05em;
    font-weight: 600;
    line-height: 1;
    min-height: 34px;
    min-width: 40px;
    transition:
      background var(--duration-default),
      transform 100ms ease,
      opacity var(--duration-default);
  }

  .nav-logo :global(.nav-logo-icon) {
    width: 16px;
    height: 16px;
    color: var(--accent);
  }

  .nav-menu-button :global(.ui-icon) {
    width: 18px;
    height: 18px;
  }

  .nav-menu-button:active {
    opacity: 0.8;
    transform: scale(0.96);
  }

  .nav-scrim {
    border: 0;
    width: 100%;
    height: 100%;
    background: var(--scrim);
    backdrop-filter: blur(2px);
    -webkit-backdrop-filter: blur(2px);
  }

  @media (max-width: 699px) {
    .nav-bar {
      display: flex;
      min-height: 42px;
      gap: 0;
      padding: 0 var(--spacing-sm);
    }

    .nav-logo {
      font-size: 1em;
      margin-right: auto;
    }

    .nav-menu-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-left: 0;
    }

    .nav-links {
      position: fixed;
      top: 42px;
      right: var(--spacing-sm);
      z-index: 60;
      width: min(220px, calc(100vw - var(--spacing-md)));
      flex-direction: column;
      gap: var(--spacing-xs);
      padding: var(--spacing-sm);
      background: var(--surface);
      border: 0.5px solid var(--border);
      border-radius: 0;
      box-shadow: 0 12px 36px var(--navigation-shadow);
      display: none;
    }

    .nav-links::-webkit-scrollbar {
      display: none;
    }

    .nav-links.open {
      display: flex;
    }

    .nav-link {
      border-radius: 0;
      font-size: 0.95em;
      padding: 10px 12px;
    }

    .nav-link.active {
      background: var(--accent-soft);
    }
  }
</style>
