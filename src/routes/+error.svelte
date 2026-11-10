<script lang="ts">
  import { page } from '$app/state';
</script>

<svelte:head><title>{page.status === 404 ? 'Not found' : 'Error'}</title></svelte:head>
<p>{page.status === 404 ? 'Not found.' : (page.error?.message ?? 'Something went wrong.')}</p>
