import type { FeedreaderApp } from './app.ts';
import { internalPath } from './router.ts';

const SELECTION_DRAG_THRESHOLDS: Readonly<Record<string, number>> = {
  mouse: 6,
  pen: 8,
  touch: 10,
};

interface PendingSelectionDrag {
  checkbox: HTMLInputElement;
  id: string;
  index: number;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
}

export function bindInteractions(app: FeedreaderApp): void {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) throw new Error('Application root is missing');
  let pendingSelectionDrag: PendingSelectionDrag | null = null;
  let dragCapture: HTMLInputElement | null = null;

  root.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.shiftKey) return;
    const target = event.target instanceof Element ? event.target : null;
    const checkbox = target?.closest('.entry-checkbox')?.querySelector<HTMLInputElement>('[data-select]');
    const row = checkbox?.closest<HTMLElement>('.entry-card');
    const index = Number.parseInt(row?.dataset.idx ?? '', 10);
    if (!checkbox?.dataset.select || !Number.isInteger(index)) return;
    pendingSelectionDrag = {
      checkbox,
      id: checkbox.dataset.select,
      index,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
    };
  });

  document.addEventListener('pointermove', event => {
    const pending = pendingSelectionDrag;
    if (pending?.pointerId === event.pointerId) {
      if (pending.pointerType === 'mouse' && (event.buttons & 1) === 0) {
        pendingSelectionDrag = null;
        return;
      }
      if (!exceedsSelectionDragThreshold(
        pending.startX,
        pending.startY,
        event.clientX,
        event.clientY,
        pending.pointerType,
      )) return;
      event.preventDefault();
      pendingSelectionDrag = null;
      dragCapture = pending.checkbox;
      app.beginDragSelection(pending.id, pending.index, event.pointerId);
      try {
        dragCapture.setPointerCapture?.(event.pointerId);
      } catch {
        // Document-level listeners still keep the drag functional if capture is unavailable.
      }
    }

    const drag = app.state.selectionDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const pointed = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.entry-card');
    app.continueDragSelection(Number.parseInt(pointed?.dataset.idx ?? '', 10));
  }, { passive: false });

  const endDrag = (event: PointerEvent) => {
    if (pendingSelectionDrag?.pointerId === event.pointerId) pendingSelectionDrag = null;
    if (!app.endDragSelection(event.pointerId)) return;
    try {
      if (dragCapture?.hasPointerCapture?.(event.pointerId)) dragCapture.releasePointerCapture(event.pointerId);
    } catch {}
    dragCapture = null;
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  root.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const entryLink = target.closest<HTMLElement>('[data-entry-link]');
    if (entryLink?.dataset.entryLink && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      app.openEntry(entryLink.dataset.entryLink);
      return;
    }
    const filter = target.closest<HTMLButtonElement>('[data-filter]');
    if (filter?.dataset.filter === 'all' || filter?.dataset.filter === 'unread' || filter?.dataset.filter === 'read') {
      app.setFilter(filter.dataset.filter);
      return;
    }
    const checkbox = target.closest<HTMLInputElement>('[data-select]');
    if (checkbox?.dataset.select) {
      if (app.state.suppressNextSelectClick) {
        event.preventDefault();
        return;
      }
      const row = checkbox.closest<HTMLElement>('.entry-card');
      app.toggleSelection(checkbox.dataset.select, Number.parseInt(row?.dataset.idx ?? '', 10), event.shiftKey);
      return;
    }
    const star = target.closest<HTMLButtonElement>('[data-star]');
    if (star?.dataset.star) {
      void app.toggleStar(star.dataset.star);
      return;
    }
    const mark = target.closest<HTMLButtonElement>('[data-mark]');
    if (mark?.dataset.mark) {
      void app.toggleRead(mark.dataset.mark);
      return;
    }
    if (target.closest('[data-loadmore]')) {
      app.showMore();
      return;
    }
    if (target.closest('[data-loadmore-feeds]')) {
      app.showMoreFeeds();
      return;
    }
    if (target.closest('[data-openall]')) {
      void app.openAllUnread();
      return;
    }
    if (target.closest('[data-markall]')) {
      void app.markAllRead();
      return;
    }
    if (target.closest('[data-refresh]')) {
      void app.refresh(true).catch(() => undefined);
      return;
    }
    if (target.closest('[data-import-feeds]')) {
      document.querySelector<HTMLInputElement>('#opml-input')?.click();
      return;
    }
    const remove = target.closest<HTMLButtonElement>('[data-delete-feed]');
    if (remove?.dataset.deleteFeed) {
      void app.deleteFeed(remove.dataset.deleteFeed, remove.dataset.feedLabel ?? '');
    }
  });

  root.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.id === 'add-feed-form') void app.addFeed(form);
    if (form.id === 'settings-form') void app.saveSettings(form);
  });

  root.addEventListener('change', event => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.id === 'opml-input') void app.importFeeds(input);
  });

  root.addEventListener('input', event => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.id === 'add-feed-url') app.setFeedAddValue(input.value);
  });

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('[data-nav-menu]')) {
      app.shell.setNavigationOpen(!app.shell.navigationOpen());
      return;
    }
    if (target.closest('[data-nav-scrim]')) {
      app.shell.setNavigationOpen(false);
      return;
    }
    if (target.closest('[data-shortcuts-close]')) {
      app.shell.setShortcutsOpen(false);
      return;
    }
    const link = target.closest<HTMLAnchorElement>('[data-link]');
    if (link && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      app.navigate(internalPath(link.pathname));
      return;
    }
    const bulk = target.closest<HTMLButtonElement>('[data-bulk]');
    if (bulk?.dataset.bulk === 'read' || bulk?.dataset.bulk === 'unread' || bulk?.dataset.bulk === 'star' ||
      bulk?.dataset.bulk === 'open' || bulk?.dataset.bulk === 'cancel') {
      void app.bulk(bulk.dataset.bulk);
    }
  });

  document.addEventListener('keydown', event => handleKeydown(app, event));
  document.addEventListener('pointerdown', event => app.dismissKeyboardNavigation(event.pointerType), true);
  document.addEventListener('pointermove', event => app.dismissKeyboardNavigation(event.pointerType), { capture: true, passive: true });
  addEventListener('popstate', () => app.navigate(internalPath(location.pathname), false));
}

export function exceedsSelectionDragThreshold(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
  pointerType = 'mouse',
): boolean {
  const threshold = SELECTION_DRAG_THRESHOLDS[pointerType] ?? SELECTION_DRAG_THRESHOLDS.mouse!;
  return Math.hypot(currentX - startX, currentY - startY) >= threshold;
}

function handleKeydown(app: FeedreaderApp, event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const active = document.activeElement;
  const typing = active instanceof Element && active.matches('input,textarea,select,[contenteditable="true"]');
  if (typing) {
    if (event.key === 'Escape' && active instanceof HTMLElement) {
      active.blur();
      event.preventDefault();
    }
    return;
  }

  if (active instanceof HTMLElement && active !== document.body && !active.closest('.entry-card')) active.blur();

  const key = event.key.toLowerCase();
  if (key === 'j' || key === 'k') app.moveFocus(key === 'j' ? 1 : -1, event.shiftKey);
  else if (key === 'o') void app.focusedAction('open');
  else if (key === 'm') void app.focusedAction('read');
  else if (key === 's') void app.focusedAction('star');
  else if (key === 'x') void app.focusedAction('select');
  else if (key === 'a') void app.markAllRead();
  else if (key === 'r') void app.refresh(true).catch(() => undefined);
  else if (event.key === '?') app.shell.setShortcutsOpen(!app.shell.shortcutsOpen());
  else if (event.key === 'Escape') app.escape();
  else return;
  event.preventDefault();
}
