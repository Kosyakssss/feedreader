import type { Store } from '#lib/server/store.ts';

declare global {
  namespace App {
    interface Locals {
      store: Store;
      wake: () => void; // lets every feed that may fetch again do so now
    }
  }
}
