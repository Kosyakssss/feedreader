// What the leaving motions draw with: the row's own leader dots, taken over by
// a canvas laid over the row, where they can move.
export const clamp = (value: number) => Math.min(1, Math.max(0, value));
export const between = (from: number, to: number, at: number) => clamp((at - from) / (to - from));
export const easeIn = (t: number) => t * t * t;
export const easeOut = (t: number) => 1 - (1 - t) ** 3;
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// A motion that plays before the row closes up, and on as it closes: `play`
// draws it at a time in milliseconds, given how much of the row's height is
// left (1 until the closing starts at `closeAt`).
export type Motion = { play: (ms: number, shown: number) => void; closeAt: number; end?: () => void };

// A part of the row, in the row's own coordinates.
export type Box = { left: number; top: number; right: number; bottom: number; x: number; y: number };

export type Layout = {
  width: number;
  height: number;
  row: HTMLElement; // the .row inside the list item
  title: HTMLElement;
  small: HTMLElement;
  buttons: HTMLElement[];
  leaders: Box;
  titleBox: Box;
  smallBox: Box;
  buttonBoxes: Box[];
  spacing: number; // from one leader dot to the next
  dots: number[]; // where each leader dot is across the row
  radius: number;
  color: string; // the leaders'
  ink: string; // the feed and date's, darker
};

// The leaders are a background of dots, one per tile, the tiles stretched to
// fit a whole number of them in (background-repeat: round): so the dots are
// found again here exactly where CSS drew them.
const LEADER = 6; // the tile, as in app.css
export const RADIUS = 1.15; // a dot as app.css draws it, edge included

export function layout(item: HTMLElement): Layout | null {
  const row = item.querySelector<HTMLElement>('.row');
  const title = item.querySelector<HTMLElement>('.title');
  const small = item.querySelector<HTMLElement>('.meta small');
  const buttons = [...item.querySelectorAll<HTMLElement>('.row-buttons > *')];
  const leadersEl = item.querySelector<HTMLElement>('.leaders');
  if (!row || !title || !small || !leadersEl) return null;
  const origin = item.getBoundingClientRect();
  const box = (element: Element): Box => {
    const rect = element.getBoundingClientRect();
    const left = rect.left - origin.left;
    const top = rect.top - origin.top;
    return {
      left,
      top,
      right: left + rect.width,
      bottom: top + rect.height,
      x: left + rect.width / 2,
      y: top + rect.height / 2,
    };
  };
  const leaders = box(leadersEl);
  const width = leaders.right - leaders.left;
  const count = Math.max(1, Math.round(width / LEADER));
  const spacing = width / count;
  return {
    width: origin.width,
    height: origin.height,
    row,
    title,
    small,
    buttons,
    leaders,
    titleBox: box(title),
    smallBox: box(small),
    buttonBoxes: buttons.map(box),
    spacing,
    dots: width >= LEADER ? Array.from({ length: count }, (_, n) => leaders.left + spacing * (n + 0.5)) : [],
    radius: RADIUS,
    color: getComputedStyle(leadersEl).color,
    ink: getComputedStyle(small).color,
  };
}

// A canvas over the row, reaching `pad` past it on every side, drawn in the
// row's coordinates. The row is lifted out of its list's clipping meanwhile.
export function overlay(item: HTMLElement, width: number, height: number, pad: number) {
  const canvas = document.createElement('canvas');
  const scale = devicePixelRatio || 1;
  canvas.width = Math.ceil((width + 2 * pad) * scale);
  canvas.height = Math.ceil((height + 2 * pad) * scale);
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, {
    position: 'absolute',
    left: `${-pad}px`,
    top: `${-pad}px`,
    width: `${width + 2 * pad}px`,
    height: `${height + 2 * pad}px`,
    pointerEvents: 'none',
  });
  Object.assign(item.style, { position: 'relative', contentVisibility: 'visible', pointerEvents: 'none' });
  item.append(canvas);
  const ctx = canvas.getContext('2d')!;
  return {
    ctx,
    clear() {
      ctx.setTransform(scale, 0, 0, scale, pad * scale, pad * scale);
      ctx.clearRect(-pad, -pad, width + 2 * pad, height + 2 * pad);
    },
    dot(x: number, y: number, radius: number, alpha = 1, stretch = 1) {
      if (radius <= 0 || alpha <= 0) return;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.ellipse(x, y, radius / Math.sqrt(stretch), radius * Math.sqrt(stretch), 0, 0, Math.PI * 2);
      ctx.fill();
    },
    remove: () => canvas.remove(),
  };
}

// Shows only what's between `from` and `to` across an element, in row
// coordinates, fading out over a few pixels at each end rather than cut.
const SOFT = 6;
export function keep(element: HTMLElement, box: Box, from: number, to: number): void {
  const width = box.right - box.left;
  const left = Math.max(from - box.left, -SOFT);
  const right = Math.min(to - box.left, width + SOFT);
  const mask =
    right <= left
      ? 'linear-gradient(transparent, transparent)'
      : left <= -SOFT && right >= width + SOFT
        ? ''
        : `linear-gradient(to right, transparent ${left}px, black ${left + SOFT}px, black ${right - SOFT}px, transparent ${right}px)`;
  element.style.maskImage = mask;
  element.style.webkitMaskImage = mask;
}

// A path of straight lines, and where along it a distance lands.
export type Path = { at: (distance: number) => [number, number]; length: number };

export function path(points: [number, number][]): Path {
  const lengths = points.slice(1).map((point, n) => Math.hypot(point[0] - points[n]![0], point[1] - points[n]![1]));
  const length = lengths.reduce((sum, part) => sum + part, 0);
  return {
    length,
    at(distance) {
      let left = Math.min(Math.max(distance, 0), length);
      for (let n = 0; n < lengths.length; n++) {
        const part = lengths[n]!;
        if (left <= part || n === lengths.length - 1) {
          const [x0, y0] = points[n]!;
          const [x1, y1] = points[n + 1]!;
          const t = part ? left / part : 0;
          return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
        }
        left -= part;
      }
      return points.at(-1)!;
    },
  };
}
