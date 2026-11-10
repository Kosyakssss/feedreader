// Which popup is open: a breadcrumb's menu or search. One at a time.
//
// A popup stays on the page while it closes, marked closing, so the CSS can
// play its way out. Everything that moves is in the CSS; this only decides
// how long a closing popup stays, which is the one motion time, --open-time.
import { SvelteSet } from 'svelte/reactivity';

let open = $state<string | null>(null);
const closing = new SvelteSet<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function openTime(): number {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--open-time')) * 1000;
}

function close(): void {
  const id = open;
  if (id === null) return;
  open = null;
  closing.add(id);
  timers.set(
    id,
    setTimeout(() => closing.delete(id), openTime()),
  );
}

export const popups = {
  isOpen: (id: string) => open === id,
  // On the page: open, or still closing.
  isShown: (id: string) => open === id || closing.has(id),
  isClosing: (id: string) => closing.has(id),
  get anyOpen() {
    return open !== null;
  },

  // Opening one closes any other. Opening one that is closing turns it back.
  open(id: string): void {
    if (open === id) return;
    close();
    clearTimeout(timers.get(id));
    closing.delete(id);
    open = id;
  },

  close,

  toggle(id: string): void {
    if (open === id) close();
    else popups.open(id);
  },

  // Gone at once, for changing page, where the whole page crossfades instead.
  reset(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    closing.clear();
    open = null;
  },
};
