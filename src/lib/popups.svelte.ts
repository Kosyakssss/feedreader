// Which popup is open: a breadcrumb's menu or search. One at a time.
//
// A popup stays on the page while it closes, marked closing, so the CSS can
// play its way out. Everything that moves is in the CSS; this only decides
// how long a closing popup stays, which is the one motion time, --open-time.
//
// An open popup is a step in the history, so Back closes it, as it would a
// page. On a phone the first Back puts the keyboard away, and the next one
// closes search. Not in Safari, though: there Back is a swipe that slides the
// page itself away, which would slide away the same page to close a menu.
import { goto } from '$app/navigation';
import { page } from '$app/state';
import { SvelteSet } from 'svelte/reactivity';

let open = $state<string | null>(null);
let step: number | null = null; // the open popup's step in the history, made or on its way
let settled: Promise<unknown> = Promise.resolve(); // the history's last change for a popup, done
const steps = typeof window !== 'undefined' && !('GestureEvent' in window); // only Safari has these
const closing = new SvelteSet<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function openTime(): number {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--open-time')) * 1000;
}

// Closes without going back: for switching popups, and for Back itself.
function shut(): void {
  const id = open;
  if (id === null) return;
  open = null;
  closing.add(id);
  timers.set(
    id,
    setTimeout(() => closing.delete(id), openTime()),
  );
}

function close(): void {
  shut();
  if (step === null) return;
  step = null;
  settled = new Promise((done) => addEventListener('popstate', done, { once: true }));
  history.back();
}

// Goes to a page from a popup, the page taking the popup's step, so that Back
// from it goes to the page before, not to this one with the popup closed.
// Going to the page already open just closes the popup.
async function visit(href: string): Promise<void> {
  await settled;
  if (new URL(href, location.href).pathname === location.pathname) return close();
  await goto(href, { replace: step !== null });
}

export const popups = {
  isOpen: (id: string) => open === id,
  // On the page: open, or still closing.
  isShown: (id: string) => open === id || closing.has(id),
  isClosing: (id: string) => closing.has(id),
  get anyOpen() {
    return open !== null;
  },

  // Opening one closes any other, in the same step. Opening one that is
  // closing turns it back.
  open(id: string): void {
    if (open === id) return;
    shut();
    clearTimeout(timers.get(id));
    closing.delete(id);
    open = id;
    if (step !== null || !steps) return;
    step = Date.now();
    settled = goto(page.url.href, { state: { popup: step }, shallow: true });
  },

  close,
  visit,

  get step() {
    return step;
  },

  // Back was pressed, or the popup's step was replaced by a page: the step is
  // gone already.
  left(): void {
    step = null;
    shut();
  },

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
    step = null;
  },
};
