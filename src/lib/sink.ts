// Reading: let go, to sink without a buoy. The row goes down under a line
// that stays where its bottom was, the water, and its leader dots, left
// floating where they were, come loose and rise as bubbles, each in its own
// time, and pop. Then the row closes over where it was.
import { between, easeOut, layout, overlay, type Motion } from './dots.ts';

const SINK = 240;
const RISE = 260; // each bubble's
const FIRST = 60; // the first bubble comes loose once the row has started to go under
const LOOSE = 80; // the last this long after the first

// The same scatter every time, from a dot's place in the line.
const scatter = (n: number, salt: number) => {
  const x = Math.sin(n * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

export function sink(item: HTMLElement): Motion | null {
  const row = layout(item);
  if (!row) return null;
  const { radius } = row;
  const depth = row.titleBox.bottom - row.titleBox.top; // a line's height
  const surface = row.leaders.y;
  const bubbles = row.dots.map((x, n) => ({
    x,
    delay: FIRST + LOOSE * scatter(n, 1),
    rise: depth * (0.5 + 0.5 * scatter(n, 2)),
    phase: scatter(n, 3) * Math.PI * 2,
  }));

  const canvas = overlay(item, row.width, row.height, 24);
  item.querySelector<HTMLElement>('.leaders')!.style.visibility = 'hidden';
  const style = row.row.style;

  function play(ms: number, shown: number): void {
    const t = between(0, SINK, ms);
    const down = depth * 1.1 * t ** 1.5; // going under, faster as it goes
    style.transform = `translateY(${down}px)`;
    style.clipPath = `inset(-24px -24px ${down}px -24px)`; // the water stays put as the row goes under it
    style.opacity = String(1 - 0.95 * Math.sqrt(t)); // dimmed at once, so the bubbles rise clear of it

    canvas.clear();
    const { ctx } = canvas;
    ctx.fillStyle = ctx.strokeStyle = row!.color;
    ctx.lineWidth = 0.75;
    for (const bubble of bubbles) {
      const age = between(bubble.delay, bubble.delay + RISE, ms);
      if (age >= 1) continue;
      const y = surface * shown - bubble.rise * easeOut(age); // the water closes up with the row
      const x = bubble.x + 1.4 * Math.sin(bubble.phase + age * 7) * age;
      if (age < 0.8) {
        canvas.dot(x, y, radius * (1 + 0.5 * age));
        continue;
      }
      const pop = (age - 0.8) / 0.2; // a ring for a moment, where it was
      ctx.globalAlpha = 1 - pop;
      ctx.beginPath();
      ctx.arc(x, y, radius * (1.5 + 1.6 * pop), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  return { play, closeAt: SINK };
}
