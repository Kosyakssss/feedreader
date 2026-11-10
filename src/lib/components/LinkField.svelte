<script lang="ts">
  // A line to paste into. Enter sends what is in it; the line below says
  // what came of it, in red if it failed.
  let {
    placeholder,
    send,
  }: { placeholder: string; send: (text: string) => Promise<{ message: string; failed?: boolean }> } = $props();

  let text = $state('');
  let busy = $state(false);
  let result = $state<{ message: string; failed?: boolean }>();

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!text.trim() || busy) return;
    busy = true;
    result = { message: 'Working…' };
    try {
      result = await send(text);
      if (!result.failed) text = '';
    } catch {
      result = { message: 'Could not reach Lagan.', failed: true };
    } finally {
      busy = false;
    }
  }
</script>

<form class="link-field field" onsubmit={submit}>
  <input type="text" bind:value={text} {placeholder} aria-label={placeholder} autocomplete="off" disabled={busy} />
  {#if result}<p class:failed={result.failed} class:muted={!result.failed}>{result.message}</p>{/if}
</form>
