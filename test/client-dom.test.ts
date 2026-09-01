import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Config, EnrichedEntry } from '../lib/types.ts';
import type { FeedreaderApi } from '../client/api.ts';
import { FeedreaderApp } from '../client/app.ts';
import { bindInteractions } from '../client/interactions.ts';
import { EntryListView } from '../client/views/entry-list.ts';
import { ShellView } from '../client/views/shell.ts';
import type { RefreshStatus } from '../client/state.ts';
import { installTestDom, type TestDom } from './dom.ts';

let dom: TestDom;

beforeEach(() => {
  dom = installTestDom();
});

afterEach(() => {
  dom.restore();
});

function config(): Config {
  return {
    maxBulkOpen: 20,
    retention: { maxEntries: 3000, maxDays: null },
    theme: 'system',
    port: 8787,
    trustedOrigins: [],
  };
}

function entry(id: string, state: EnrichedEntry['state'] = {}): EnrichedEntry {
  return {
    id,
    sourceId: id,
    feedId: 'feed',
    feedLabel: 'Feed',
    title: `Entry ${id}`,
    url: `https://example.com/${id}`,
    published: '2026-08-25T00:00:00.000Z',
    state,
  };
}

function status(overrides: Partial<RefreshStatus> = {}): RefreshStatus {
  return {
    count: 0,
    refreshing: false,
    error: null,
    runId: 'run',
    total: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    failures: [],
    cursor: 0,
    feedCursor: 0,
    newEntries: [],
    feedResults: [],
    removedIds: [],
    ...overrides,
  };
}

function client(overrides: Partial<FeedreaderApi> = {}): FeedreaderApi {
  return {
    config: async () => config(),
    saveConfig: async value => ({ ...config(), ...value }),
    entries: async () => [],
    feeds: async () => ({ folders: [], feeds: [], health: {} }),
    startRefresh: async () => status(),
    refreshStatus: async () => status(),
    updateEntries: async () => ({ ok: true }),
    addFeed: async () => ({
      feed: { id: 'feed', url: 'https://example.com/feed.xml', label: 'Feed', folderId: null },
      entries: [],
      health: { lastFetched: Date.now(), error: null, entryCount: 0 },
    }),
    deleteFeed: async () => ({ ok: true }),
    importFeeds: async () => ({ feeds: [], added: 0, skipped: 0 }),
    ...overrides,
  };
}

function renderedApp(api = client(), entries: EnrichedEntry[] = [entry('one')]): FeedreaderApp {
  const root = document.querySelector<HTMLElement>('#app')!;
  const app = new FeedreaderApp(root, api);
  app.state.entries = entries;
  app.state.initialDataLoading = false;
  app.navigate('/', false);
  bindInteractions(app);
  return app;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('client orchestration', () => {
  test('loads all initial resources as one observed request group', async () => {
    const calls: string[] = [];
    const app = new FeedreaderApp(document.querySelector<HTMLElement>('#app')!, client({
      entries: async () => { calls.push('entries'); return [entry('loaded')]; },
      config: async () => { calls.push('config'); return config(); },
      feeds: async () => { calls.push('feeds'); return { folders: [], feeds: [], health: {} }; },
    }));

    await app.start();
    expect(calls.slice(0, 3).sort()).toEqual(['config', 'entries', 'feeds']);
    expect(app.state.initialDataLoading).toBe(false);
    expect(document.querySelector('[data-id="loaded"]')).not.toBeNull();
  });

  test('checkbox, star, and read controls dispatch real app actions', async () => {
    const updates: Record<string, { read?: boolean; starred?: boolean }>[] = [];
    const app = renderedApp(client({
      updateEntries: async payload => {
        updates.push(payload);
        return { ok: true };
      },
    }));

    document.querySelector<HTMLInputElement>('[data-select="one"]')!.click();
    expect(app.state.selectedIds.has('one')).toBe(true);
    expect(document.querySelector<HTMLInputElement>('[data-select="one"]')!.checked).toBe(true);

    document.querySelector<HTMLButtonElement>('[data-star="one"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-mark="one"]')!.click();
    await Promise.resolve();
    expect(updates).toEqual([{ one: { starred: true } }, { one: { read: true } }]);
  });

  test('touch movement crosses the drag threshold and ends cleanly', () => {
    const app = renderedApp();
    const checkbox = document.querySelector<HTMLInputElement>('[data-select="one"]')!;
    checkbox.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      pointerId: 7,
      pointerType: 'touch',
      clientX: 10,
      clientY: 10,
    }));
    document.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      pointerId: 7,
      pointerType: 'touch',
      clientX: 30,
      clientY: 10,
    }));
    expect(app.state.selectionDrag).toMatchObject({ pointerId: 7, selecting: true });
    expect(app.state.selectedIds.has('one')).toBe(true);
    expect(checkbox.checked).toBe(true);

    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, pointerType: 'touch' }));
    expect(app.state.selectionDrag).toBeNull();
  });

  test('opens and dismisses mobile navigation through delegated controls', () => {
    renderedApp();
    document.querySelector<HTMLButtonElement>('[data-nav-menu]')!.click();
    expect(document.body.classList.contains('nav-menu-open')).toBe(true);
    expect(document.querySelector('[data-nav-menu]')?.getAttribute('aria-expanded')).toBe('true');

    document.querySelector<HTMLElement>('[data-nav-scrim]')!.click();
    expect(document.body.classList.contains('nav-menu-open')).toBe(false);
    expect(document.querySelector('[data-nav-menu]')?.getAttribute('aria-expanded')).toBe('false');
  });

  test('resynchronizes after overlapping optimistic failures instead of restoring stale state', async () => {
    const first = deferred<{ ok: boolean }>();
    const second = deferred<{ ok: boolean }>();
    let writes = 0;
    let reads = 0;
    const app = renderedApp(client({
      entries: async () => {
        reads += 1;
        return [entry('one', { read: false, readAt: 1 })];
      },
      updateEntries: () => (++writes === 1 ? first.promise : second.promise),
    }), [entry('one', { read: false, readAt: 1 })]);

    const older = app.toggleRead('one');
    const newer = app.toggleRead('one');
    second.reject(new Error('newer failed'));
    await newer;
    expect(app.state.entries[0]?.state?.read).toBe(true);
    first.reject(new Error('older failed'));
    await older;

    expect(reads).toBe(1);
    expect(app.state.entries[0]?.state?.read).toBe(false);
  });

  test('preserves the add form through refresh updates and shows pending errors inline', async () => {
    const add = deferred<Awaited<ReturnType<FeedreaderApi['addFeed']>>>();
    const app = renderedApp(client({ addFeed: () => add.promise }));
    app.state.feeds = {
      folders: [],
      feeds: [{ id: 'feed', url: 'https://example.com/feed.xml', label: 'Feed', folderId: null }],
      health: { feed: { lastFetched: null, error: null, entryCount: 0 } },
    };
    app.navigate('/feeds', false);

    const input = document.querySelector<HTMLInputElement>('#add-feed-url')!;
    input.value = 'https://new.example/feed.xml';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dataset.identity = 'original';
    document.querySelector<HTMLButtonElement>('#add-feed-form button[type="submit"]')!.click();

    expect(document.querySelector('#add-feed-form')?.getAttribute('aria-busy')).not.toBeNull();
    await new Promise(resolve => setTimeout(resolve, 130));
    expect(document.querySelector('.feed-pending')?.textContent).toContain('Finding and checking feed');
    expect(document.querySelector('.feed-pending-slot > .feed-pending')).not.toBeNull();

    const applyStatus = app as unknown as { applyRefreshStatus(value: RefreshStatus): void };
    applyStatus.applyRefreshStatus(status({ refreshing: true, total: 1, completed: 1, succeeded: 1 }));
    expect(document.querySelector<HTMLInputElement>('#add-feed-url')?.dataset.identity).toBe('original');
    expect(document.querySelector<HTMLInputElement>('#add-feed-url')?.value).toBe('https://new.example/feed.xml');

    add.reject(new Error('No feed found'));
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector('#add-feed-status')?.textContent).toContain('No feed found');
    expect(document.querySelector('#add-feed-status')?.classList.contains('is-visible')).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#add-feed-url')?.value).toBe('https://new.example/feed.xml');
  });

  test('keeps a retried pending row when its prior exit animation is canceled', async () => {
    const animations = new WeakMap<HTMLElement, Animation[]>();
    const prototype = HTMLElement.prototype as HTMLElement & {
      animate: typeof HTMLElement.prototype.animate;
      getAnimations: typeof HTMLElement.prototype.getAnimations;
    };
    const originalAnimate = prototype.animate;
    const originalGetAnimations = prototype.getAnimations;
    prototype.animate = function (_frames, options) {
      let resolveFinished!: () => void;
      let rejectFinished!: () => void;
      const finished = new Promise<void>((resolve, reject) => {
        resolveFinished = resolve;
        rejectFinished = () => reject(new DOMException('Canceled', 'AbortError'));
      });
      const rejectsOnCancel = (this as unknown as HTMLElement).classList.contains('feed-slot')
        && typeof options === 'object'
        && options.fill === 'forwards';
      const animation = {
        finished,
        addEventListener: () => undefined,
        cancel: () => rejectsOnCancel ? rejectFinished() : resolveFinished(),
      } as unknown as Animation;
      const node = this as unknown as HTMLElement;
      animations.set(node, [...(animations.get(node) ?? []), animation]);
      return animation;
    };
    prototype.getAnimations = function () {
      return animations.get(this as unknown as HTMLElement) ?? [];
    };

    try {
      const first = deferred<Awaited<ReturnType<FeedreaderApi['addFeed']>>>();
      const second = deferred<Awaited<ReturnType<FeedreaderApi['addFeed']>>>();
      let calls = 0;
      const app = renderedApp(client({ addFeed: () => (++calls === 1 ? first.promise : second.promise) }));
      app.navigate('/feeds', false);
      const input = document.querySelector<HTMLInputElement>('#add-feed-url')!;
      input.value = 'example.com/feed.xml';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const submit = document.querySelector<HTMLButtonElement>('#add-feed-form button[type="submit"]')!;

      submit.click();
      await new Promise(resolve => setTimeout(resolve, 130));
      first.reject(new Error('Try again'));
      await Promise.resolve();
      await Promise.resolve();
      expect(document.querySelector('.feed-pending-slot')?.getAttribute('data-exiting')).toBe('true');

      submit.click();
      await new Promise(resolve => setTimeout(resolve, 130));
      expect(calls).toBe(2);
      expect(document.querySelector('.feed-pending-slot')).not.toBeNull();
      expect(document.querySelector('.feed-pending-slot')?.hasAttribute('data-exiting')).toBe(false);

      second.reject(new Error('Done'));
      await Promise.resolve();
    } finally {
      prototype.animate = originalAnimate;
      prototype.getAnimations = originalGetAnimations;
    }
  });

  test('finishes a successful add by overlaying the pending row without a layout gap', async () => {
    const prototype = HTMLElement.prototype as HTMLElement & { animate: typeof HTMLElement.prototype.animate };
    const originalAnimate = prototype.animate;
    const animations: Array<{
      node: HTMLElement;
      frames: Keyframe[] | PropertyIndexedKeyframes | null;
      options?: number | KeyframeAnimationOptions;
    }> = [];
    prototype.animate = function (frames, options) {
      animations.push({ node: this as unknown as HTMLElement, frames, options });
      return ({
        finished: Promise.resolve(),
        addEventListener: () => undefined,
        cancel: () => undefined,
      }) as unknown as Animation;
    };

    try {
      const added = deferred<Awaited<ReturnType<FeedreaderApi['addFeed']>>>();
      const app = renderedApp(client({ addFeed: () => added.promise }));
      app.navigate('/feeds', false);
      const input = document.querySelector<HTMLInputElement>('#add-feed-url')!;
      input.value = 'new.example/feed.xml';
      document.querySelector<HTMLButtonElement>('#add-feed-form button[type="submit"]')!.click();
      await new Promise(resolve => setTimeout(resolve, 130));
      expect(document.querySelector('.feed-pending-slot')).not.toBeNull();
      const animationsBeforeSuccess = animations.length;

      added.resolve({
        feed: { id: 'new', url: 'https://new.example/feed.xml', label: 'New', folderId: null },
        entries: [],
        health: { lastFetched: Date.now(), error: null, entryCount: 0 },
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const firstSlot = document.querySelector<HTMLElement>('.feed-list > .feed-slot');
      expect(document.querySelector('.feed-pending-slot')).toBeNull();
      expect(firstSlot?.dataset.feedId).toBe('new');
      expect(firstSlot?.style.position).toBe('');
      const replacement = animations.find(animation =>
        animation.node.classList.contains('feed-item') && !animation.node.classList.contains('feed-pending'));
      expect(JSON.stringify(replacement?.frames)).toContain('inset(100% 0 0 0)');
      expect(JSON.stringify(replacement?.frames)).not.toContain('opacity');
      expect((replacement?.options as KeyframeAnimationOptions | undefined)?.duration).toBe(280);
      expect(animations.slice(animationsBeforeSuccess)
        .some(animation => animation.node.classList.contains('feed-pending'))).toBe(false);
    } finally {
      prototype.animate = originalAnimate;
    }
  });

  test('does not flash a searching row for an immediate add error', async () => {
    const app = renderedApp(client({ addFeed: async () => { throw new Error('No feed found'); } }));
    app.navigate('/feeds', false);
    const input = document.querySelector<HTMLInputElement>('#add-feed-url')!;
    input.value = 'not-a-feed.example';
    document.querySelector<HTMLButtonElement>('#add-feed-form button[type="submit"]')!.click();

    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector('.feed-pending-slot')).toBeNull();
    expect(document.querySelector('#add-feed-status')?.textContent).toContain('No feed found');
    expect(input.autocomplete).toBe('off');
    expect(input.getAttribute('aria-autocomplete')).toBe('none');
  });

  test('keeps import progress nodes stable while feed results advance', () => {
    const app = renderedApp();
    app.state.feeds = {
      folders: [],
      feeds: [
        { id: 'one', url: 'https://one.example/feed.xml', label: 'One', folderId: null },
        { id: 'two', url: 'https://two.example/feed.xml', label: 'Two', folderId: null },
      ],
      health: {},
    };
    app.state.feedImport = {
      total: 2,
      completed: 0,
      succeeded: 0,
      failed: 0,
      active: true,
      feedIds: new Set(['one', 'two']),
      completedIds: new Set(),
    };
    app.navigate('/feeds', false);
    const meter = document.querySelector<HTMLProgressElement>('.feed-import-meter')!;

    const applyStatus = app as unknown as { applyRefreshStatus(value: RefreshStatus): void };
    applyStatus.applyRefreshStatus(status({
      refreshing: true,
      total: 2,
      completed: 1,
      succeeded: 1,
      feedCursor: 1,
      feedResults: [{ sequence: 1, feedId: 'one', entryCount: 3, error: null, completedAt: Date.now() }],
    }));

    expect(document.querySelector('.feed-import-meter')).toBe(meter);
    expect(meter.value).toBe(1);
    expect(document.querySelector('.feed-import-slot')?.classList.contains('is-visible')).toBe(true);
    expect(document.querySelector('.feed-import-title')?.textContent).toContain('1 / 2');
  });

  test('uses a stable two-step delete control and blocks repeated deletion requests', async () => {
    const prototype = HTMLElement.prototype as HTMLElement & {
      animate: (frames: Keyframe[] | PropertyIndexedKeyframes, options?: number | KeyframeAnimationOptions) => Animation;
    };
    const originalAnimate = prototype.animate;
    const animations: Array<{
      frames: Keyframe[] | PropertyIndexedKeyframes | null;
      options?: number | KeyframeAnimationOptions;
    }> = [];
    prototype.animate = (frames, options) => {
      animations.push({ frames, options });
      return ({
      finished: Promise.resolve(),
      addEventListener: () => undefined,
      cancel: () => undefined,
      }) as unknown as Animation;
    };
    const deletion = deferred<{ ok: boolean }>();
    let calls = 0;
    const app = renderedApp(client({ deleteFeed: () => { calls += 1; return deletion.promise; } }));
    app.state.feeds = {
      folders: [],
      feeds: [{ id: 'feed', url: 'https://example.com/feed.xml', label: 'Feed', folderId: null }],
      health: { feed: { lastFetched: null, error: null, entryCount: 0 } },
    };
    app.navigate('/feeds', false);

    const button = document.querySelector<HTMLButtonElement>('[data-delete-feed="feed"]')!;
    expect(button.querySelectorAll('.feed-delete-icon')).toHaveLength(2);
    button.click();
    expect(button.classList.contains('is-confirming')).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('Confirm removal of Feed');

    document.body.click();
    expect(button.classList.contains('is-confirming')).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Remove Feed');

    button.click();
    button.click();
    button.click();
    expect(calls).toBe(1);
    expect(button.disabled).toBe(true);
    expect(button.classList.contains('is-deleting')).toBe(true);

    deletion.resolve({ ok: true });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(app.state.feeds.feeds).toHaveLength(0);
    expect(JSON.stringify(animations)).not.toContain('translateX');
    expect(JSON.stringify(animations)).not.toContain('scaleY');
    expect(JSON.stringify(animations)).toContain('translateY');
    const collapse = animations.find(animation => JSON.stringify(animation.frames).includes('height'));
    expect((collapse?.options as KeyframeAnimationOptions | undefined)?.duration).toBe(260);
    expect((collapse?.options as KeyframeAnimationOptions | undefined)?.easing).toBe('linear');
    prototype.animate = originalAnimate;
  });
});

describe('keyed entry rendering and motion', () => {
  test('updates existing rows through cached nodes', () => {
    const view = new EntryListView();
    document.querySelector('#app')!.append(view.element);
    const item = entry('cached');
    const options = {
      loading: false,
      selectedIds: new Set<string>(),
      focusedEntryId: null,
      totalCount: 1,
      loadLimit: 50,
    };
    view.update([item], options);
    const card = view.element.querySelector<HTMLElement>('.entry-card')!;
    card.querySelector = () => { throw new Error('existing card was queried again'); };

    item.title = 'Changed title';
    item.state.starred = true;
    view.update([item], { ...options, selectedIds: new Set(['cached']) });

    expect(card.querySelector).toBeDefined();
    expect(view.element.querySelector('.entry-title')?.textContent).toBe('Changed title');
    expect(view.element.querySelector<HTMLInputElement>('[data-select="cached"]')?.checked).toBe(true);
    expect(view.element.querySelector('[data-star="cached"]')?.classList.contains('starred')).toBe(true);
  });

  test('preserves existing nodes, inserts in the middle, and animates the new row', () => {
    const prototype = HTMLElement.prototype as HTMLElement & {
      animate: (frames: Keyframe[] | PropertyIndexedKeyframes, options?: number | KeyframeAnimationOptions) => Animation;
      getAnimations: () => Animation[];
    };
    const originalAnimate = prototype.animate;
    const originalGetAnimations = prototype.getAnimations;
    const originalRect = prototype.getBoundingClientRect;
    let animations = 0;
    prototype.getAnimations = () => [];
    prototype.getBoundingClientRect = () => new DOMRect(0, 100, 700, 60);
    prototype.animate = () => {
      animations += 1;
      return new EventTarget() as unknown as Animation;
    };
    try {
      const view = new EntryListView();
      document.querySelector('#app')!.append(view.element);
      const options = {
        loading: false,
        selectedIds: new Set<string>(),
        focusedEntryId: null,
        totalCount: 2,
        loadLimit: 50,
      };
      view.update([entry('a'), entry('c')], options);
      const existing = view.element.querySelector('[data-id="c"]');
      view.update([entry('a'), entry('b'), entry('c')], {
        ...options,
        totalCount: 3,
        animate: true,
        newIds: new Set(['b']),
      });

      expect([...view.element.querySelectorAll<HTMLElement>('.entry-slot[data-id]')].map(row => row.dataset.id)).toEqual(['a', 'b', 'c']);
      expect(view.element.querySelector('.entry-slot[data-id="c"]')).toBe(existing);
      expect(animations).toBe(2);
    } finally {
      prototype.animate = originalAnimate;
      prototype.getAnimations = originalGetAnimations;
      prototype.getBoundingClientRect = originalRect;
    }
  });
});

describe('shell accessibility', () => {
  test('advances discrete refresh bars and collapses to the final outcome', async () => {
    const shell = new ShellView({ segmentScanMs: 1, completeHoldMs: 1 });
    const appState = renderedApp().state;
    appState.refreshStatus = status({ refreshing: true, total: 4, completed: 1, succeeded: 1 });
    shell.update(appState);
    await new Promise(resolve => setTimeout(resolve, 4));
    const bars = [...document.querySelectorAll<HTMLElement>('.refresh-bar')];
    expect(bars.map(bar => bar.classList.contains('is-filled'))).toEqual([true, false, false, false]);
    expect(bars[1]?.classList.contains('is-active')).toBe(true);

    appState.refreshStatus = status({ refreshing: false, total: 4, completed: 4, succeeded: 4 });
    shell.update(appState);
    await new Promise(resolve => setTimeout(resolve, 12));
    const indicator = document.querySelector<HTMLElement>('#refresh-status')!;
    expect(indicator.dataset.phase).toBe('complete-collapsed');
    expect(indicator.getAttribute('aria-label')).toBe('All refreshed');
    expect(document.querySelector('[data-refresh-label]')?.textContent).toBe('All refreshed');
  });

  test('moves focus into the shortcuts dialog, traps it, and restores the trigger', () => {
    const shell = new ShellView();
    const trigger = document.querySelector<HTMLButtonElement>('[data-nav-menu]')!;
    trigger.focus();
    shell.setShortcutsOpen(true);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('#shortcuts-overlay button')];
    expect(document.activeElement).toBe(buttons[0]!);

    buttons.at(-1)!.focus();
    buttons.at(-1)!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }));
    expect(document.activeElement).toBe(buttons[0]!);

    shell.setShortcutsOpen(false);
    expect(document.activeElement).toBe(trigger);
  });

  test('uses stable toggle labels and a live toast region', () => {
    const app = renderedApp(client(), [entry('one', { read: true, starred: true })]);
    expect(document.querySelector('[data-star="one"]')?.getAttribute('aria-label')).toBe('Star entry');
    expect(document.querySelector('[data-mark="one"]')?.getAttribute('aria-label')).toBe('Read entry');
    expect(document.querySelector('[data-id="one"]')?.hasAttribute('aria-selected')).toBe(false);
    app.shell.toast('Saved');
    expect(document.querySelector('#toast-container')?.getAttribute('aria-live')).toBe('polite');
    expect(document.querySelector('.toast')?.textContent).toBe('Saved');
  });
});
