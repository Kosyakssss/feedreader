// Choosing several entries on a page, to read or bookmark them together.
// Select puts a box on every row. Pressing a row, or its box, chooses it;
// Shift-pressing chooses everything from the last one pressed; and dragging
// across the boxes chooses, or unchooses, every row the pointer passes, as
// the first row was turned. A mouse can drag from anywhere on a row; a finger
// only from the boxes, so that anywhere else it scrolls.
//
// Taken from the old feedreader, whose choosing held up: rows are found by
// their place on the page, so that rows arriving or leaving while choosing
// change nothing chosen, and a drag never ends as a press as well.
import { SvelteSet } from 'svelte/reactivity';
import type { Entry } from '#lib/server/store.ts';

// How far a pointer goes before a press becomes a drag.
const DRAG = { touch: 10, pen: 8, mouse: 6 } as Record<string, number>;

export class Selection {
  choosing = $state(false);
  ids = new SvelteSet<number>();

  private anchor: number | null = null; // the last row pressed, where Shift ranges from
  private pending: { id: number; pointer: number; type: string; x: number; y: number } | null = null;
  private drag: { pointer: number; type: string; choose: boolean; id: number } | null = null;
  private dragged = false; // the press that ends a drag isn't one more press

  constructor(private shown: () => Entry[]) {}

  // The chosen entries, in the page's order.
  get chosen(): Entry[] {
    return this.shown().filter((entry) => this.ids.has(entry.id));
  }

  get all(): boolean {
    const shown = this.shown();
    return shown.length > 0 && shown.every((entry) => this.ids.has(entry.id));
  }

  start(): void {
    this.choosing = true;
  }

  stop(): void {
    this.choosing = false;
    this.ids.clear();
    this.anchor = null;
    this.pending = this.drag = null;
  }

  chooseAll(): void {
    if (this.all) this.ids.clear();
    else for (const entry of this.shown()) this.ids.add(entry.id);
    this.anchor = null;
  }

  // Rows that left the page leave the choice too.
  keep(shown: Entry[]): void {
    const ids = new Set(shown.map((entry) => entry.id));
    for (const id of this.ids) if (!ids.has(id)) this.ids.delete(id);
    if (this.anchor !== null && !ids.has(this.anchor)) this.anchor = null;
  }

  // A row or its box pressed. A box turns itself; the release that ends a
  // drag turns nothing.
  press(event: MouseEvent, id: number): void {
    if (this.dragged) return event.preventDefault();
    const shown = this.shown();
    const choose = !this.ids.has(id);
    const from = this.anchor === null ? -1 : shown.findIndex((entry) => entry.id === this.anchor);
    const to = shown.findIndex((entry) => entry.id === id);
    if (event.shiftKey && from >= 0 && to >= 0)
      for (const entry of shown.slice(Math.min(from, to), Math.max(from, to) + 1)) this.set(entry.id, choose);
    else this.set(id, choose);
    this.anchor = id;
  }

  down(event: PointerEvent, id: number): void {
    if (!this.choosing || event.button || event.shiftKey) return;
    const target = event.target as Element;
    if (target.closest('.card')) return; // what opens below a row is its own
    if (event.pointerType === 'touch' && !target.closest('.check')) return;
    this.pending = { id, pointer: event.pointerId, type: event.pointerType, x: event.clientX, y: event.clientY };
  }

  move(event: PointerEvent): void {
    const pending = this.pending;
    if (pending?.pointer === event.pointerId) {
      if (pending.type === 'mouse' && !(event.buttons & 1)) {
        this.pending = null;
        return;
      }
      if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < (DRAG[pending.type] ?? 6)) return;
      this.pending = null;
      this.drag = { pointer: event.pointerId, type: pending.type, choose: !this.ids.has(pending.id), id: pending.id };
      this.dragged = true;
      this.set(pending.id, this.drag.choose);
      this.anchor = pending.id;
    }
    const drag = this.drag;
    if (drag?.pointer !== event.pointerId) return;
    if (drag.type === 'mouse' && !(event.buttons & 1)) return this.up(event); // let go outside the window
    event.preventDefault();
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-id]');
    const id = Number(row?.dataset.id);
    const shown = this.shown();
    const from = shown.findIndex((entry) => entry.id === drag.id);
    const to = shown.findIndex((entry) => entry.id === id);
    if (from < 0 || to < 0) return;
    for (const entry of shown.slice(Math.min(from, to), Math.max(from, to) + 1)) this.set(entry.id, drag.choose);
    this.anchor = id;
  }

  up(event: PointerEvent): void {
    if (this.pending?.pointer === event.pointerId) this.pending = null;
    if (this.drag?.pointer !== event.pointerId) return;
    this.drag = null;
    setTimeout(() => (this.dragged = false)); // after the click this pointer's release makes
  }

  private set(id: number, chosen: boolean): void {
    if (chosen) this.ids.add(id);
    else this.ids.delete(id);
  }
}
