import { Window } from 'happy-dom';

const DOM_GLOBALS = [
  'window',
  'document',
  'location',
  'history',
  'navigator',
  'Element',
  'HTMLElement',
  'HTMLAnchorElement',
  'HTMLButtonElement',
  'HTMLFormElement',
  'HTMLInputElement',
  'HTMLSpanElement',
  'FormData',
  'DOMRect',
  'Event',
  'MouseEvent',
  'PointerEvent',
  'KeyboardEvent',
  'getComputedStyle',
  'matchMedia',
  'addEventListener',
  'removeEventListener',
  'innerHeight',
  'scrollY',
  'scrollBy',
  'confirm',
] as const;

export interface TestDom {
  window: Window;
  restore(): void;
}

export function installTestDom(): TestDom {
  const window = new Window({ url: 'http://localhost/' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const name of DOM_GLOBALS) previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));

  const values: Record<(typeof DOM_GLOBALS)[number], unknown> = {
    window,
    document: window.document,
    location: window.location,
    history: window.history,
    navigator: window.navigator,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLAnchorElement: window.HTMLAnchorElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLFormElement: window.HTMLFormElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSpanElement: window.HTMLSpanElement,
    FormData: window.FormData,
    DOMRect: window.DOMRect,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    KeyboardEvent: window.KeyboardEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    matchMedia: window.matchMedia.bind(window),
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    innerHeight: 900,
    scrollY: 0,
    scrollBy: () => undefined,
    confirm: () => true,
  };
  for (const name of DOM_GLOBALS) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  }

  window.document.body.innerHTML = `
    <nav class="nav-bar">
      <a data-nav="/" class="nav-link"></a>
      <button id="refresh-status" data-refresh-status data-phase="idle" aria-expanded="false">
        <span data-refresh-label></span>
        <span data-refresh-graphic>
          <span class="refresh-bar"></span><span class="refresh-bar"></span>
          <span class="refresh-bar"></span><span class="refresh-bar"></span>
        </span>
        <span data-refresh-live></span>
      </button>
      <button data-nav-menu aria-expanded="false"></button>
      <div data-nav-scrim hidden></div>
    </nav>
    <main id="app"></main>
    <div id="bulk-bar" hidden><span id="bulk-count"></span></div>
    <div id="shortcuts-overlay" role="dialog" aria-modal="true" hidden>
      <button data-shortcuts-first>First</button>
      <button data-shortcuts-close>Close</button>
    </div>
    <div id="toast-container" role="status" aria-live="polite" aria-atomic="true"></div>
  `;

  return {
    window,
    restore() {
      window.close();
      for (const name of DOM_GLOBALS) {
        const descriptor = previous.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      }
    },
  };
}
