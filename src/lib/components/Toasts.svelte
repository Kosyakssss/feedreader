<script lang="ts">
  import { useReader } from '$lib/client/reader.svelte';
  import { toastOut } from '$lib/client/motion';
  const reader = useReader();
</script>

<div class="toast-container" role="status" aria-live="polite" aria-atomic="true">
  {#each reader.toasts as toast (toast.id)}<div class="toast" out:toastOut>{toast.message}</div>{/each}
</div>

<style>
  .toast-container {
    position: fixed;
    right: var(--spacing-lg);
    bottom: var(--spacing-lg);
    z-index: 60;
  }

  .toast {
    background: var(--surface);
    border: 0.5px solid var(--border);
    border-radius: 0;
    box-shadow:
      0 4px 24px var(--toast-shadow),
      0 0 0 0.5px var(--toast-outline);
    color: var(--foreground);
    font-size: 0.875em;
    font-weight: 500;
    padding: 10px var(--spacing-md);
    animation: toast-in 250ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.94);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  @media (max-width: 699px) {
    .toast-container {
      left: var(--spacing-sm);
      right: var(--spacing-sm);
      bottom: var(--spacing-sm);
    }

    :global(.bulk-active) .toast-container {
      bottom: calc(128px + var(--spacing-sm) + env(safe-area-inset-bottom));
    }

    .toast {
      width: 100%;
    }
  }
</style>
