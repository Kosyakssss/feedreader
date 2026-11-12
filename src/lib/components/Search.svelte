<script lang="ts">
  import { popups } from '#lib/popups.svelte.ts';
  import type { Entry, Source } from '#lib/server/store.ts';
  import FeedList from './FeedList.svelte';
  import Row from './Row.svelte';
  import SearchIcon from './SearchIcon.svelte';

  type Results = { query: string; feeds: Pick<Source, 'id' | 'label'>[]; entries: Entry[] };

  let input = $state<HTMLInputElement>();
  let query = $state('');
  let results = $state<Results>({ query: '', feeds: [], entries: [] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: AbortController | undefined;

  export function focus(): void {
    input?.focus({ preventScroll: true }); // the page holds still; search moves itself above the keyboard
  }

  // Asks once typing pauses, and only the latest question counts.
  function ask(): void {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const asked = query.trim();
      inFlight?.abort();
      if (!asked) {
        results = { query: '', feeds: [], entries: [] };
        return;
      }
      inFlight = new AbortController();
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(asked)}`, { signal: inFlight.signal });
        if (response.ok) results = { query: asked, ...(await response.json()) };
      } catch {
        // replaced by a newer question, or offline: the last answer stays
      }
    }, 200);
  }
</script>

{#if popups.isShown('search')}
  <div id="search" class="popup" class:closing={popups.isClosing('search')}>
    <div class="search-bar">
      <input
        bind:this={input}
        bind:value={query}
        oninput={ask}
        type="text"
        placeholder="Search"
        aria-label="Search"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        enterkeyhint="search"
      />
      <button class="icon" aria-label="Close search" data-popup-toggle onclick={() => popups.close()}>
        <SearchIcon />
      </button>
    </div>
    <!-- Results are plain links: an entry goes out to its post, a feed to its page. -->
    <div id="results">
      {#if results.query}
        {#if !results.feeds.length && !results.entries.length}
          <p>Nothing found.</p>
        {/if}
        {#if results.feeds.length}<FeedList feeds={results.feeds} />{/if}
        {#if results.entries.length}
          <ol class="entries">
            {#each results.entries as entry (entry.id)}<Row {entry} />{/each}
          </ol>
        {/if}
      {/if}
    </div>
  </div>
{/if}
