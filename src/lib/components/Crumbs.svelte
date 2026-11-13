<script lang="ts">
  import { fades } from '#lib/fades.ts';
  import { popups } from '#lib/popups.svelte.ts';
  import { FEEDS, type Crumb, type Link } from '#lib/trail.ts';

  let { trail }: { trail: Crumb[] } = $props();

  const onTrail = (href: string) => (trail.some((crumb) => crumb.href === href) ? 'page' : undefined);
  const label = (link: Link) => (link === FEEDS ? `${link.label}/` : link.label);

  // A double press goes to the name's page: the system's own double click,
  // counted at its own speed. Safari on a phone doesn't count taps, so
  // there two presses as quick as a double tap count instead.
  let last: { href: string; at: number } | undefined;
  function press(event: MouseEvent, id: string, href: string): void {
    const counted = !(event instanceof PointerEvent) || event.pointerType !== 'mouse';
    const twice = event.detail > 1 || (counted && last?.href === href && event.timeStamp - last.at < 350);
    last = twice ? undefined : { href, at: event.timeStamp };
    if (twice) popups.visit(href);
    else popups.toggle(id);
  }
</script>

<!-- Pressing a name opens or closes what is under it, and pressing it twice
     goes to its page. A name with nothing under it is just text. -->
<nav>
  {#each trail as step, index (step.href)}
    {@const current = index === trail.length - 1 ? 'page' : undefined}
    {#if step.under}
      {@const id = `menu-${index}`}
      <div class="crumb" aria-current={current}>
        <button aria-expanded={popups.isOpen(id)} data-popup-toggle onclick={(event) => press(event, id, step.href)}>
          {step.label}<span class="slash"></span>
        </button>
        {#if popups.isShown(id)}
          <div class="menu popup" class:closing={popups.isClosing(id)}>
            <div class="menu-list" {@attach fades}>
              {#each step.under as link (link.href)}
                <a href={link.href} aria-current={onTrail(link.href)}>{label(link)}</a>
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
