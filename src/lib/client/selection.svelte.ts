import { SvelteSet } from 'svelte/reactivity';
import type { EnrichedEntry } from '../types';
export class Selection {
  ids = new SvelteSet<string>();
  focused = $state<string | null>(null);
  keyboard = $state(false);
  private anchor: string | null = null;
  private drag: {
    pointer: number;
    selecting: boolean;
    index: number;
  } | null = null;
  private pending: {
    id: string;
    index: number;
    pointer: number;
    type: string;
    x: number;
    y: number;
  } | null = null;
  suppressClick = false;
  constructor(private visible: () => EnrichedEntry[]) {}
  clear(): void {
    this.ids.clear();
    this.anchor = null;
  }
  reset(): void {
    this.clear();
    this.focused = null;
    this.keyboard = false;
  }
  toggle(id: string, index: number, range = false): void {
    const selecting = !this.ids.has(id),
      entries = this.visible();
    const anchor = this.anchor ? entries.findIndex((entry) => entry.id === this.anchor) : 0;
    if (range && anchor >= 0 && index >= 0)
      for (let i = Math.min(index, anchor); i <= Math.max(index, anchor); i++)
        this.set(entries[i]!.id, selecting);
    else this.set(id, selecting);
    this.anchor = id;
  }
  move(direction: 1 | -1, extend: boolean): void {
    const entries = this.visible();
    if (!entries.length) return;
    let index = entries.findIndex((entry) => entry.id === this.focused);
    if (extend && index >= 0) this.ids.add(entries[index]!.id);
    index = direction === 1 ? Math.min(index + 1, entries.length - 1) : Math.max(index - 1, 0);
    this.focused = entries[index]!.id;
    this.keyboard = true;
    if (extend) {
      this.ids.add(this.focused);
      this.anchor = this.focused;
    }
  }
  dismiss(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && this.keyboard) {
      this.keyboard = false;
      this.focused = null;
    }
  }
  down(event: PointerEvent, id: string, index: number): void {
    if (event.button || event.shiftKey) return;
    this.pending = {
      id,
      index,
      pointer: event.pointerId,
      type: event.pointerType,
      x: event.clientX,
      y: event.clientY,
    };
  }
  movePointer(event: PointerEvent): void {
    const pending = this.pending;
    if (pending?.pointer === event.pointerId) {
      if (pending.type === 'mouse' && !(event.buttons & 1)) {
        this.pending = null;
        return;
      }
      const threshold = pending.type === 'touch' ? 10 : pending.type === 'pen' ? 8 : 6;
      if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < threshold) return;
      this.drag = { pointer: event.pointerId, selecting: !this.ids.has(pending.id), index: pending.index };
      this.pending = null;
      this.suppressClick = true;
      this.set(pending.id, this.drag.selecting);
      this.anchor = pending.id;
    }
    const drag = this.drag;
    if (!drag || drag.pointer !== event.pointerId) return;
    event.preventDefault();
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-idx]');
    const index = Number(row?.dataset.idx);
    if (!row || !Number.isInteger(index)) return;
    const entries = this.visible();
    for (let i = Math.min(index, drag.index); i <= Math.max(index, drag.index); i++)
      if (entries[i]) this.set(entries[i]!.id, drag.selecting);
    drag.index = index;
    this.anchor = entries[index]?.id ?? null;
  }
  up(event: PointerEvent): void {
    if (this.pending?.pointer === event.pointerId) this.pending = null;
    if (this.drag?.pointer === event.pointerId) {
      this.drag = null;
      setTimeout(() => (this.suppressClick = false), 0);
    }
  }
  private set(id: string, selected: boolean): void {
    if (selected) this.ids.add(id);
    else this.ids.delete(id);
  }
}
