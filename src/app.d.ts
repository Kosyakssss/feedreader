import type { Store } from '#lib/server/store.ts';

declare global {
  namespace App {
    interface Locals {
      store: Store;
      wake: () => void; // lets every feed that may fetch again do so now
      follow: (id: number) => void; // starts fetching a feed just added
    }
    interface PageState {
      popup?: number; // the step made by opening a popup, so Back closes it
    }
  }
}
