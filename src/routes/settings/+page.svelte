<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { Config } from '$lib/types';
  import { useReader, message } from '$lib/client/reader.svelte';
  import { api } from '$lib/client/api';
  const reader = useReader();
  let draft = $state<Config>(untrack(() => structuredClone($state.snapshot(reader.config))));
  let dirty = $state(false),
    saving = $state(false);
  const appearances = $derived(reader.themes.find((theme) => theme.name === draft.theme)?.appearances ?? []);
  $effect(() => {
    const config = reader.config;
    if (!dirty) draft = structuredClone($state.snapshot(config));
  });
  onMount(() => {
    void api
      .themes()
      .then((themes) => (reader.themes = themes))
      .catch((error) => reader.toast(message(error)));
  });
  function themeChanged() {
    dirty = true;
    if (draft.appearance !== 'system' && !appearances.includes(draft.appearance)) draft.appearance = 'system';
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    try {
      reader.config = await api.saveConfig({
        maxBulkOpen: draft.maxBulkOpen,
        retention: {
          maxEntries: draft.retention.maxEntries,
          ...(draft.retention.maxDays === undefined ? {} : { maxDays: draft.retention.maxDays }),
        },
        theme: draft.theme,
        appearance: draft.appearance,
      });
      dirty = false;
      reader.toast('Settings saved');
    } catch (error) {
      reader.toast(`Error: ${message(error)}`);
    } finally {
      saving = false;
    }
  }
</script>

<div class="page settings-page" data-page="settings">
  <div class="page-header"><h1 class="page-title">Settings</h1></div>
  <form class="settings-form" onsubmit={save} oninput={() => (dirty = true)}>
    <div class="settings-field">
      <label for="setting-theme">Theme</label>
      <select id="setting-theme" bind:value={draft.theme} onchange={themeChanged}>
        {#each reader.themes as theme}<option value={theme.name}>{theme.name}</option>{/each}
      </select>
    </div>
    <div class="settings-field">
      <label for="setting-appearance">Appearance</label>
      <select id="setting-appearance" bind:value={draft.appearance} onchange={() => (dirty = true)}>
        <option value="system">System</option><option value="light" disabled={!appearances.includes('light')}
          >Light</option
        >
        <option value="dark" disabled={!appearances.includes('dark')}>Dark</option>
      </select>
    </div>
    <div class="settings-field">
      <label for="setting-bulk">Max bulk open tabs</label>
      <input id="setting-bulk" type="number" min="1" max="500" required bind:value={draft.maxBulkOpen} />
    </div>
    <div class="settings-field">
      <label for="setting-entries">Max entries to keep</label>
      <input
        id="setting-entries"
        type="number"
        min="100"
        max="100000"
        required
        bind:value={draft.retention.maxEntries}
      />
    </div>
    <div class="settings-field">
      <label for="setting-days">Max entry age (days, empty = no limit)</label>
      <input id="setting-days" type="number" min="1" max="36500" bind:value={draft.retention.maxDays} />
    </div>
    <button class="btn btn-primary" disabled={saving}>Save</button>
  </form>
</div>

<style>
  .settings-form {
    display: flex;
    width: 100%;
    max-width: 400px;
    margin-inline: auto;
    flex-direction: column;
    gap: var(--spacing-md);
  }

  .settings-page .page-header {
    width: 100%;
    max-width: 400px;
    margin-inline: auto;
  }

  .settings-field {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs);
  }

  .settings-form label {
    font-size: 0.9em;
    color: var(--foreground);
    font-weight: 500;
  }

  .settings-form :is(input, select) {
    background-color: var(--field-background);
    border: 1px solid transparent;
    border-radius: 0;
    padding: 7px var(--spacing-sm);
    color: var(--foreground);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    transition: none;
  }

  .settings-form :is(input, select):focus {
    outline: none;
    background-color: var(--surface);
    border-color: var(--accent);
    box-shadow: 0 0 0 3.5px var(--field-focus-ring);
  }

  @media (max-width: 699px) {
    .settings-form :is(input, select) {
      font-size: 16px;
    }
  }
</style>
