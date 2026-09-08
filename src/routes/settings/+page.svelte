<script lang="ts">
  import { useReader, message } from '$lib/client/reader.svelte';
  import { api } from '$lib/client/api';
  const reader = useReader();
  let form = $state<HTMLFormElement>();
  $effect(() => {
    const config = reader.config;
    if (!form) return;
    for (const [name, value] of Object.entries({ maxBulkOpen: config.maxBulkOpen, ...config.retention })) {
      const input = form.elements.namedItem(name) as HTMLInputElement;
      if (input && (input.value === input.defaultValue || input.value === String(value ?? '')))
        input.value = input.defaultValue = String(value ?? '');
    }
  });
  async function save(event: SubmitEvent) {
    event.preventDefault();
    const values = new FormData(form);
    const number = (name: string, fallback: number) =>
      Number.parseInt(String(values.get(name)), 10) || fallback;
    try {
      reader.config = await api.saveConfig({
        maxBulkOpen: number('maxBulkOpen', 20),
        retention: {
          maxEntries: number('maxEntries', 3000),
          maxDays: String(values.get('maxDays')).trim() ? number('maxDays', 1) : null,
        },
      });
      reader.toast('Settings saved');
    } catch (error) {
      reader.toast(`Error: ${message(error)}`);
    }
  }
</script>

<div class="page settings-page" data-page="settings">
  <div class="page-header"><h1 class="page-title">Settings</h1></div>
  <form class="settings-form" bind:this={form} onsubmit={save}>
    {#each [{ name: 'maxBulkOpen', label: 'Max bulk open tabs', min: 1 }, { name: 'maxEntries', label: 'Max entries to keep', min: 100 }, { name: 'maxDays', label: 'Max entry age (days, empty = no limit)', min: 1 }] as field}
      <div class="settings-field">
        <label for={`setting-${field.name}`}>{field.label}</label><input
          id={`setting-${field.name}`}
          name={field.name}
          type="number"
          min={field.min}
        />
      </div>
    {/each}<button type="submit" class="btn btn-primary" disabled={reader.loading}>Save</button>
  </form>
</div>
