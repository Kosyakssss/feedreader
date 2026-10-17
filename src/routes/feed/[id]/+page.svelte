<script lang="ts">
  import Entries from '$lib/components/Entries.svelte';
  import { page } from '$app/state';
</script>

<Entries feedId={page.params.id} />
