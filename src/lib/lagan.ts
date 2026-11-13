// Bookmarking: what the app is named for. Lagan is cargo let down into the sea
// on a line, with a buoy, to be found and brought up again later.
//
// The leader dots eat their line, the feed and the date one way and the
// buttons the other; run up both sides of the row, and eat the title in from
// both ends until they meet in the middle. Then the whole line of them is
// drawn in after its ends, out along the bottom, up the sides and into the
// middle, into one dot: the buoy. It bobs up, drops, and goes into the water
// with a ring or two and a splash, and the row closes over it.
import { between, easeIn, easeInOut, easeOut, keep, layout, overlay, path, type Motion } from './dots.ts';

const EAT = 480; // the dots eating both lines
const REEL = 300; // drawn in, into one
const HOP = 340; // up, and down into the water
const SPLASH = 520;

export function lagan(item: HTMLElement): Motion | null {
  const row = layout(item);
  if (!row || !row.dots.length) return null;
  const { leaders, titleBox, smallBox, buttonsBox, spacing, radius } = row;

  const my = leaders.y;
  const mx = (leaders.left + leaders.right) / 2;
  const ty = titleBox.y;
  const cx = row.width / 2;
  const side = spacing * 1.5; // the sides run just outside the row's text
  const xl = Math.min(titleBox.left, smallBox.left) - side;
  const xr = row.width + side;
  const water = ty + (my - ty) * 0.55;

  // Two halves, from the middle of the leaders round to the middle of the
  // title, each with its own dots. An odd dot in the middle goes left.
  const halves = [
    {
      path: path([
        [mx, my],
        [xl, my],
        [xl, ty],
        [cx, ty],
      ]),
      start: mx - leaders.left,
      first: 0,
    },
    {
      path: path([
        [mx, my],
        [xr, my],
        [xr, ty],
        [cx, ty],
      ]),
      start: leaders.right - mx,
      first: 0,
    },
  ];
  const odd = row.dots.length % 2 === 1;
  halves[0]!.first = odd ? 0 : spacing / 2;
  halves[1]!.first = odd ? spacing : spacing / 2;
  const dots = halves.map((half) => {
    const along: number[] = [];
    for (let s = half.first; s <= half.path.length; s += spacing) along.push(s);
    return along;
  });
  const metaEnd = [mx - xl, xr - mx]; // where each half leaves the bottom line
  const titleStart = [metaEnd[0]! + (my - ty), metaEnd[1]! + (my - ty)];

  const canvas = overlay(item, row.width, row.height, 40);
  const leadersEl = item.querySelector<HTMLElement>('.leaders')!;
  leadersEl.style.visibility = 'hidden';

  function play(ms: number): void {
    canvas.clear();
    canvas.ctx.fillStyle = row!.color;
    canvas.ctx.strokeStyle = row!.color;

    if (ms >= EAT + REEL) {
      canvas.ctx.fillStyle = row!.ink; // the buoy, gathered from them, is darker than the dots
      canvas.ctx.strokeStyle = row!.ink;
    }

    if (ms < EAT + REEL) {
      const eaten = easeInOut(between(0, EAT, ms));
      const reel = easeIn(between(EAT, EAT + REEL, ms));
      const fronts = halves.map((half) => half.start + (half.path.length - half.start) * eaten);

      halves.forEach((half, n) => {
        for (const s of dots[n]!) {
          if (s > fronts[n]!) break;
          const grown = between(0, spacing * 1.5, fronts[n]! - s); // a dot pops up as the front reaches it
          const at = s + (half.path.length - s) * reel;
          const [x, y] = half.path.at(at);
          canvas.dot(x, y, radius * easeOut(grown) * (1 + 0.6 * reel));
        }
      });

      // What the fronts have passed is gone.
      const [left, right] = fronts as [number, number];
      keep(row!.small, smallBox, smallBox.left, left < metaEnd[0]! ? mx - left : -Infinity);
      keep(row!.buttons, buttonsBox, right < metaEnd[1]! ? mx + right : Infinity, buttonsBox.right);
      const titleLeft = left > titleStart[0]! ? halves[0]!.path.at(left)[0] : -Infinity;
      const titleRight = right > titleStart[1]! ? halves[1]!.path.at(right)[0] : Infinity;
      keep(row!.title, titleBox, titleLeft, titleRight);
      return;
    }

    const hop = ms - EAT - REEL;
    if (hop < HOP) {
      // Up a little, slowing; then down, quickening, a drop stretched by its fall.
      const up = 0.38;
      const t = hop / HOP;
      const y = t < up ? ty - 9 * easeOut(t / up) : ty - 9 + (water - ty + 9) * easeIn((t - up) / (1 - up));
      const fall = t < up ? 0 : (t - up) / (1 - up);
      canvas.dot(cx, y, radius * 2.1, 1, 1 + 0.6 * fall * fall);
      return;
    }

    // Into the water: rings spreading flat across it, and two drops thrown up.
    const splash = hop - HOP;
    if (splash > SPLASH) return;
    const { ctx } = canvas;
    ctx.lineWidth = 1;
    for (const [delay, reach, strength] of [
      [0, 28, 0.9],
      [110, 16, 0.6],
    ] as const) {
      const t = between(delay, delay + SPLASH - 110, splash);
      if (t <= 0 || t >= 1) continue;
      const rx = 2.5 + reach * easeOut(t);
      ctx.globalAlpha = strength * (1 - t) ** 1.5;
      ctx.beginPath();
      ctx.ellipse(cx, water, rx, rx * 0.3, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    const thrown = between(0, 300, splash);
    if (thrown < 1)
      for (const way of [-1, 1]) {
        const x = cx + way * 8 * thrown;
        const y = water - 11 * thrown + 14 * thrown * thrown;
        canvas.dot(x, y, radius, 1 - thrown);
      }
  }

  return { play, closeAt: EAT + REEL + HOP + 240, end: canvas.remove };
}
