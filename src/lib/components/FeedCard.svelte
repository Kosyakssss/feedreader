<script lang="ts">
  import { refreshAll } from '$app/navigation';
  import type { Source } from '#lib/server/store.ts';

  let { feed, mutes }: { feed: Source; mutes: string[] } = $props();

  let words = $derived(mutes.join(', ')); // edited here, until the saved words come back
  let saved = $state(true);
  let failed = $state(false);
  let confirming = $state(false);

  // Muted words are kept the moment the field is left or Enter is pressed.
  async function saveMutes(): Promise<void> {
    if (saved) return;
    failed = false;
    const response = await fetch(`/api/feeds/${feed.id}/mutes`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words: words.split(',') }),
    }).catch(() => null);
    if (!response?.ok) {
      failed = true;
      return;
    }
    words = ((await response.json()) as { words: string[] }).words.join(', ');
    saved = true;
  }

  // Asks once more before removing.
  async function remove(): Promise<void> {
    if (!confirming) {
      confirming = true;
      return;
    }
    const response = await fetch(`/api/feeds/${feed.id}`, { method: 'DELETE' }).catch(() => null);
    if (response?.ok) await refreshAll();
    else failed = true;
  }
</script>

<div class="card-body">
  <p class="muted address">{feed.ref}</p>
  {#if feed.error}<p class="failed">{feed.error}</p>{/if}
  <label class="field">
    <span class="muted">Muted words</span>
    <input
      type="text"
      bind:value={words}
      class:failed
      placeholder="none"
      autocomplete="off"
      autocapitalize="off"
      enterkeyhint="done"
      oninput={() => (saved = false)}
      onblur={saveMutes}
      onkeydown={(event) => event.key === 'Enter' && saveMutes()}
    />
  </label>
  <div>
    <button class:failed={failed && confirming} onclick={remove} onblur={() => (confirming = false)}>
      {confirming ? 'Remove for good' : 'Remove feed'}
    </button>
  </div>
</div>
