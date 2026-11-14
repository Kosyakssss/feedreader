<script lang="ts">
  import { displayTitle } from '#lib/format.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>Lagan</title>
  <meta name="theme-color" content="#4385be" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#205ea6" media="(prefers-color-scheme: dark)" />
</svelte:head>

<ol>
  {#each data.entries as entry (entry.id)}
    <li id="e{entry.id}">
      <a href={entry.url}>{displayTitle(entry)}</a>
      <div>
        <span>{entry.feed}</span>
        <form method="post" action="?/keep">
          <input type="hidden" name="id" value={entry.id} />
          <button name="keep" value={entry.bookmarked ? '0' : '1'}>{entry.bookmarked ? 'kept' : 'keep'}</button>
        </form>
      </div>
    </li>
  {/each}
</ol>

<style>
  /* Flexoki: its two blues, light and dark, its text, and its paper for links.
     A link already opened is a deeper cream. */
  :global(html) {
    --link: #fffcf0;
    --opened: #f6e2a0;
    color-scheme: light dark;
    background: light-dark(#4385be, #205ea6);
    color: light-dark(#100f0f, #cecdc3);
    font:
      1.125rem/1.4 -apple-system,
      BlinkMacSystemFont,
      'Inter',
      'Segoe UI',
      Helvetica,
      Arial,
      sans-serif;
    -webkit-text-size-adjust: 100%;
  }

  :global(body) {
    margin: 0;
  }

  ol {
    max-width: 40rem;
    margin: 0 auto;
    padding: max(1.5rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right))
      max(1.5rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left));
    list-style: none;
  }

  li {
    margin-block-end: 1.25rem;
    scroll-margin-block: 30vh; /* back from keeping, the entry sits a little way down */
  }

  a,
  button {
    color: var(--link);
    text-decoration: underline;
    text-underline-offset: 0.15em;
  }

  a:visited {
    color: var(--opened);
  }

  /* A title has two lines at most. */
  a {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
  }

  /* The feed, cut to one line, with keep at its end. */
  div {
    display: flex;
    gap: 1rem;
    align-items: baseline;
    font-size: 0.875em;
  }

  span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  button {
    padding: 0.25em 0;
    border: 0;
    background: none;
    font: inherit;
    cursor: pointer;
  }
</style>
