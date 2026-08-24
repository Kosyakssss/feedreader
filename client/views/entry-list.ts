import type { EnrichedEntry } from '../../lib/types.ts';
import { animateEntryChanges } from '../motion/entries.ts';
import { safeHttpUrl, timeAgo } from '../state.ts';
import { button, element } from './dom.ts';
import { icon, setIcon } from './icons.ts';

export interface EntryListOptions {
  loading: boolean;
  selectedIds: ReadonlySet<string>;
  focusedEntryId: string | null;
  totalCount: number;
  loadLimit: number;
  newIds?: ReadonlySet<string>;
  animate?: boolean;
}

interface EntryRow {
  slot: HTMLDivElement;
  card: HTMLDivElement;
}

export class EntryListView {
  readonly element = element('div');
  private list: HTMLDivElement | null = null;
  private rows = new Map<string, EntryRow>();

  constructor() {
    this.element.id = 'entry-list';
  }

  update(entries: readonly EnrichedEntry[], options: EntryListOptions): void {
    if (options.loading) {
      this.showMessage('Loading saved entries…');
      return;
    }
    if (entries.length === 0) {
      this.showMessage('No entries');
      return;
    }

    const anchor = options.animate ? this.scrollAnchor() : null;

    if (!this.list) {
      this.list = element('div', 'entry-list');
      this.list.setAttribute('role', 'list');
      this.element.replaceChildren(this.list);
    }

    const visibleIds = new Set(entries.map(entry => entry.id));
    for (const [id, row] of this.rows) {
      if (!visibleIds.has(id)) {
        row.slot.remove();
        this.rows.delete(id);
      }
    }

    const orderedRows: EntryRow[] = [];
    entries.forEach((entry, index) => {
      const row = this.rows.get(entry.id) ?? this.createRow(entry);
      this.rows.set(entry.id, row);
      this.updateRow(row, entry, index, options);
      orderedRows.push(row);
    });
    reconcileRowOrder(this.list, orderedRows.map(row => row.slot));

    this.updateLoadMore(options.totalCount, options.loadLimit);

    if (anchor && scrollY > 72) {
      const currentAnchor = this.rows.get(anchor.id);
      if (currentAnchor) {
        const delta = currentAnchor.slot.getBoundingClientRect().top - anchor.top;
        if (Math.abs(delta) >= 0.5) window.scrollBy(0, delta);
      }
    }

    if (options.animate && options.newIds?.size) {
      animateEntryChanges(orderedRows.map(row => row.slot), options.newIds);
    }
  }

  private showMessage(message: string): void {
    this.list = null;
    this.rows.clear();
    this.element.replaceChildren(element('div', 'empty-state', message));
  }

  private updateLoadMore(totalCount: number, loadLimit: number): void {
    this.element.querySelector('.load-more')?.remove();
    if (totalCount <= loadLimit) return;
    const wrapper = element('div', 'load-more');
    const more = button(`Show more (${totalCount - loadLimit} remaining)`);
    more.dataset.loadmore = '';
    wrapper.append(more);
    this.element.append(wrapper);
  }

  private scrollAnchor(): { id: string; top: number } | null {
    const topEdge = document.querySelector('.nav-bar')?.getBoundingClientRect().bottom ?? 0;
    for (const child of this.list?.children ?? []) {
      if (!(child instanceof HTMLElement) || !child.dataset.id) continue;
      const rect = child.getBoundingClientRect();
      if (rect.bottom > topEdge) return { id: child.dataset.id, top: rect.top };
    }
    return null;
  }

  private createRow(entry: EnrichedEntry): EntryRow {
    const slot = element('div', 'entry-slot');
    slot.setAttribute('role', 'listitem');
    const card = element('div', 'entry-card');

    const checkboxLabel = element('label', 'entry-checkbox');
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.select = entry.id;
    checkbox.setAttribute('aria-label', `Select ${entry.title || 'entry'}`);
    checkboxLabel.append(checkbox);

    const leading = element('span', 'entry-leading-space');
    leading.setAttribute('aria-hidden', 'true');

    const content = element('div', 'entry-content');
    const titleSlot = element('span', 'entry-title-slot');
    const metadata = element('span', 'entry-meta');
    metadata.dir = 'auto';
    content.append(titleSlot, metadata);

    const actions = element('div', 'entry-actions');
    const star = button('', 'btn-icon btn-star');
    star.append(icon('star'));
    star.dataset.star = entry.id;
    star.title = 'Star';
    star.setAttribute('aria-label', 'Star entry');
    const mark = button('', 'btn-icon btn-mark');
    mark.append(icon('circle-filled'));
    mark.dataset.mark = entry.id;
    actions.append(star, mark);

    card.append(checkboxLabel, leading, content, actions);
    slot.append(card);
    return { slot, card };
  }

  private updateRow(row: EntryRow, entry: EnrichedEntry, index: number, options: EntryListOptions): void {
    const read = !!entry.state?.read;
    const starred = !!entry.state?.starred;
    const selected = options.selectedIds.has(entry.id);
    const focused = options.focusedEntryId === entry.id;
    row.slot.dataset.id = entry.id;
    row.slot.setAttribute('aria-selected', String(selected));
    row.card.className = `entry-card ${read ? 'entry-read' : 'entry-unread'}${selected ? ' entry-selected' : ''}${focused ? ' entry-focused' : ''}`;
    row.card.dataset.id = entry.id;
    row.card.dataset.idx = String(index);

    const checkbox = row.card.querySelector<HTMLInputElement>('[data-select]');
    if (checkbox) {
      checkbox.dataset.select = entry.id;
      checkbox.checked = selected;
      checkbox.setAttribute('aria-label', `Select ${entry.title || 'entry'}`);
    }

    const titleSlot = row.card.querySelector<HTMLElement>('.entry-title-slot');
    if (titleSlot) {
      const safeUrl = safeHttpUrl(entry.url);
      const title = entry.title || 'Untitled';
      const current = titleSlot.firstElementChild;
      const needsLink = !!safeUrl;
      const titleNode = current && (needsLink ? current instanceof HTMLAnchorElement : current instanceof HTMLSpanElement)
        ? current
        : needsLink ? element('a') : element('span');
      titleNode.className = 'entry-title';
      titleNode.textContent = title;
      titleNode.setAttribute('dir', 'auto');
      if (titleNode instanceof HTMLAnchorElement) {
        titleNode.href = safeUrl;
        titleNode.target = '_blank';
        titleNode.rel = 'noopener';
        titleNode.dataset.entryLink = entry.id;
      }
      if (titleNode !== current) titleSlot.replaceChildren(titleNode);
    }

    const metadata = row.card.querySelector<HTMLElement>('.entry-meta');
    if (metadata) metadata.textContent = `${entry.feedLabel || 'Unknown'} · ${timeAgo(entry.published)}`;

    const star = row.card.querySelector<HTMLButtonElement>('.btn-star');
    if (star) {
      star.dataset.star = entry.id;
      star.classList.toggle('starred', starred);
      setIcon(star, starred ? 'star-filled' : 'star');
      star.setAttribute('aria-pressed', String(starred));
      star.title = starred ? 'Unstar' : 'Star';
      star.setAttribute('aria-label', starred ? 'Unstar entry' : 'Star entry');
    }
    const mark = row.card.querySelector<HTMLButtonElement>('.btn-mark');
    if (mark) {
      mark.dataset.mark = entry.id;
      setIcon(mark, read ? 'circle' : 'circle-filled');
      mark.title = read ? 'Mark unread' : 'Mark read';
      mark.setAttribute('aria-label', mark.title);
      mark.setAttribute('aria-pressed', String(read));
    }
  }
}

function reconcileRowOrder(list: HTMLDivElement, rows: readonly HTMLDivElement[]): void {
  rows.forEach((row, index) => {
    const current = list.children.item(index);
    if (current !== row) list.insertBefore(row, current);
  });
}
