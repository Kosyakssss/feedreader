<script lang="ts">
  import { popups } from '#lib/popups.svelte.ts';
  import { FEEDS, type Crumb } from '#lib/trail.ts';

  let { trail }: { trail: Crumb[] } = $props();
</script>

<!-- Pressing a name opens or closes what is under it. While the menu is still
     animating, the link on top of the name takes a second press to that page.
     A name with nothing under it is just text. -->
<nav>
  {#each trail as step, index (step.href)}
    {@const current = index === trail.length - 1 ? 'page' : undefined}
    {#if step.under}
      {@const id = `menu-${index}`}
      <div class="crumb" aria-current={current}>
        <button aria-expanded={popups.isOpen(id)} data-popup-toggle onclick={() => popups.toggle(id)}>{step.label}<span class="slash"></span></button>
        <a class="press-again" href={step.href} tabindex="-1" aria-hidden="true"></a>
        {#if popups.isShown(id)}
          <div class="menu popup" class:closing={popups.isClosing(id)}>
            <div class="menu-list">
              {#each step.under as link (link.href)}
                <a href={link.href} aria-current={trail.some((crumb) => crumb.href === link.href) ? 'page' : undefined}>{link.label}{link === FEEDS ? '/' : ''}</a>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {:else}
      <span class="crumb" aria-current={current}>{step.label}</span>
    {/if}
  {/each}
</nav>
