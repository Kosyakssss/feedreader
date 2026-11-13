// Reading: let go, to sink without a buoy. The row goes down under a line
// that stays where its bottom was, the water, and its leader dots, left
// floating where they were, come loose and rise as bubbles, each in its own
// time, and pop. Then the row closes over where it was.
import { between, easeOut, layout, overlay, type Motion } from './dots.ts';

const SINK = 460;
const RISE = 380; // each bubble's
const LOOSE = 150; // the last bubble comes loose this long after the first

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
    delay: LOOSE * scatter(n, 1),
    rise: depth * (0.55 + 0.6 * scatter(n, 2)),
    phase: scatter(n, 3) * Math.PI * 2,
  }));

  const canvas = overlay(item, row.width, row.height, 24);
  item.querySelector<HTMLElement>('.leaders')!.style.visibility = 'hidden';
  const style = row.row.style;

  function play(ms: number): void {
    const sunk = between(0, SINK, ms) ** 2; // going under, faster as it goes
    const down = depth * 1.1 * sunk;
    style.transform = `translateY(${down}px)`;
    style.clipPath = `inset(-24px -24px ${down}px -24px)`; // the water stays put as the row goes under it
    style.opacity = String(1 - 0.7 * sunk);

    canvas.clear();
    canvas.ctx.fillStyle = row!.color;
    canvas.ctx.strokeStyle = row!.color;
    canvas.ctx.lineWidth = 0.75;
    for (const bubble of bubbles) {
      const t = between(bubble.delay, bubble.delay + RISE, ms);
      if (t >= 1) continue;
      const y = surface - bubble.rise * easeOut(t);
      const x = bubble.x + 1.4 * Math.sin(bubble.phase + t * 7) * t;
      if (t < 0.82) {
        canvas.dot(x, y, radius * (1 + 0.5 * t));
        continue;
      }
      const pop = (t - 0.82) / 0.18; // a ring for a moment, where it was
      canvas.ctx.globalAlpha = 1 - pop;
      canvas.ctx.beginPath();
      canvas.ctx.arc(x, y, radius * (1.5 + 1.6 * pop), 0, Math.PI * 2);
      canvas.ctx.stroke();
    }
  }

  return { play, closeAt: Math.max(SINK, LOOSE + RISE) - 20, end: canvas.remove };
}
