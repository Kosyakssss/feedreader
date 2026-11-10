<script lang="ts">
  import { refreshAll } from '$app/navigation';

  let result = $state<{ message: string; failed?: boolean }>();

  async function importFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    result = { message: `Reading ${file.name}…` };
    const response = await fetch('/api/opml', {
      method: 'POST',
      body: await file.text(),
      headers: { Accept: 'application/json' },
    }).catch(() => null);
    input.value = '';
    if (!response?.ok) {
      result = { message: 'That file could not be read as OPML.', failed: true };
      return;
    }
    const { found, added }: { found: number; added: number } = await response.json();
    result = { message: `${found} feeds in the file, ${added} new. ${added ? 'They are being fetched now.' : ''}` };
    await refreshAll();
  }
</script>

<svelte:head><title>Settings</title></svelte:head>

<section class="setting">
  <h2>Feeds file</h2>
  <p class="muted">OPML: the list of feeds other readers import and export.</p>
  <div class="setting-actions">
    <a class="button" href="/api/opml" download="lagan.opml" data-sveltekit-reload>Export</a>
    <label class="button"
      >Import<input type="file" accept=".opml,.xml,text/xml,text/x-opml" onchange={importFile} hidden /></label
    >
  </div>
  {#if result}<p class:failed={result.failed} class:muted={!result.failed}>{result.message}</p>{/if}
</section>
