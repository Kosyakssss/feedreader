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

const EAT = 240; // the dots eating both lines
const REEL = 150; // drawn in, into one
const HOP = 200; // up, and down into the water
const SPLASH = 380; // the rings, spreading as the row closes over them

export function lagan(item: HTMLElement): Motion | null {
  const row = layout(item);
  if (!row || !row.dots.length) return null;
  const { leaders, titleBox, smallBox, buttonBoxes, spacing, radius } = row;

  const my = leaders.y;
  const mx = (leaders.left + leaders.right) / 2;
  const ty = titleBox.y;
  const cx = row.width / 2;
  const side = spacing * 1.5; // the sides run just outside the row's text
  const xl = Math.min(titleBox.left, smallBox.left) - side;
  const xr = row.width + side;
  const water = ty + (my - ty) * 0.55;

  // Two halves, from the middle of the leaders round to the middle of the
  // title, each with its own dots, spaced as the leaders are. An odd dot in
  // the middle goes left.
  const odd = row.dots.length % 2 === 1;
  const halves = [
    { corners: [xl, my, xl, ty], start: mx - leaders.left, first: odd ? 0 : spacing / 2 },
    { corners: [xr, my, xr, ty], start: leaders.right - mx, first: odd ? spacing : spacing / 2 },
  ].map(({ corners: [x1, y1, x2, y2], start, first }) => {
    const line = path([
      [mx, my],
      [x1!, y1!],
      [x2!, y2!],
      [cx, ty],
    ]);
    const dots: number[] = [];
    for (let s = first; s <= line.length; s += spacing) dots.push(s);
    return { line, start, dots, bottom: Math.abs(x1! - mx), title: Math.abs(x1! - mx) + (my - ty) };
  });

  const canvas = overlay(item, row.width, row.height, 40);
  item.querySelector<HTMLElement>('.leaders')!.style.visibility = 'hidden';

  function play(ms: number, shown: number): void {
    canvas.clear();
    const { ctx } = canvas;

    if (ms < EAT + REEL) {
      ctx.fillStyle = row!.color;
      const eaten = easeInOut(between(0, EAT, ms));
      const reel = easeIn(between(EAT, EAT + REEL, ms));
      const fronts = halves.map((half) => half.start + (half.line.length - half.start) * eaten);

      halves.forEach((half, n) => {
        for (const s of half.dots) {
          if (s > fronts[n]!) break;
          const grown = easeOut(between(0, spacing * 1.5, fronts[n]! - s)); // a dot swells in as the front reaches it
          const [x, y] = half.line.at(s + (half.line.length - s) * reel);
          canvas.dot(x, y, radius * grown * (1 + reel), 1 - 0.5 * reel * (1 - s / half.line.length));
        }
      });
      if (reel) canvas.dot(cx, ty, radius * 2.4 * reel, reel); // the buoy, gathering

      // What the fronts have passed is gone: the feed and date one way, each
      // button the other, shrinking away as the front reaches it, and the
      // title in from both ends.
      const [left, right] = fronts as [number, number];
      const [l, r] = halves;
      keep(row!.small, smallBox, smallBox.left, left < l!.bottom ? mx - left : -Infinity);
      row!.buttons.forEach((button, n) => {
        const box = buttonBoxes[n]!;
        const gone = right < r!.bottom ? between(box.left - mx, box.right - mx, right) : 1;
        button.style.scale = String(1 - easeIn(gone));
        button.style.opacity = String(1 - gone);
      });
      keep(
        row!.title,
        titleBox,
        left > l!.title ? l!.line.at(left)[0] : -Infinity,
        right > r!.title ? r!.line.at(right)[0] : Infinity,
      );
      return;
    }

    ctx.fillStyle = ctx.strokeStyle = row!.ink; // the buoy is darker than the dots it gathered
    const hop = ms - EAT - REEL;
    if (hop < HOP) {
      // Up a little, slowing; then down, quickening, a drop stretched by its fall.
      const up = 0.35;
      const t = hop / HOP;
      const fall = t < up ? 0 : (t - up) / (1 - up);
      const y = t < up ? ty - 8 * easeOut(t / up) : ty - 8 + (water - ty + 8) * easeIn(fall);
      canvas.dot(cx, y, radius * 2.4, 1, 1 + 0.7 * fall * fall);
      return;
    }

    // Into the water: rings spreading flat across it, and two drops thrown up.
    // The water closes up with the row.
    const splash = hop - HOP;
    if (splash > SPLASH) return;
    const surface = water * shown;
    ctx.lineWidth = 1;
    for (const [delay, reach, strength] of [
      [0, 30, 0.9],
      [70, 18, 0.6],
    ] as const) {
      const t = between(delay, SPLASH, splash);
      if (t <= 0 || t >= 1) continue;
      const rx = 3 + reach * easeOut(t);
      ctx.globalAlpha = strength * (1 - t) ** 1.5;
      ctx.beginPath();
      ctx.ellipse(cx, surface, rx, rx * 0.3, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    const thrown = between(0, 220, splash);
    if (thrown < 1)
      for (const way of [-1, 1])
        canvas.dot(cx + way * 8 * thrown, surface - 10 * thrown + 13 * thrown * thrown, radius, 1 - thrown);
  }

  return { play, closeAt: EAT + REEL + HOP, end: canvas.remove };
}
