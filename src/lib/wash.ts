// A watercolour wash, drawn once as a mask for a page button's pool of glass.
// The pool is the header's glass, solid from the screen's edge and from what
// it stands on to a gap past the words, as the header's glass is around the
// breadcrumbs. Only past that does it dissolve, at its top and inner side: a
// wavy line, softened, with a little grain where the colour thins out. Drawn
// into a picture at the pool's size, and again only when that changes; a mask
// made of SVG filters is redrawn by the browser on every frame the page
// scrolls under it, which stalls it.

type Side = 'start' | 'end';

// The same waves every time, so a redraw on resize doesn't make them jump.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

// A gentle swell: a few slow waves on top of each other, together never
// further than reach from the line they ride on.
function swell(seed: number, reach: number): (at: number) => number {
  const next = random(seed);
  const waves = [52, 31, 19].map((length) => ({
    length,
    phase: next() * Math.PI * 2,
    size: (reach / 3) * (0.5 + next() / 2),
  }));
  return (at) =>
    waves.reduce((sum, wave) => sum + wave.size * Math.sin((at / wave.length) * Math.PI * 2 + wave.phase), 0);
}

// Smooth grain: random values on a coarse grid, blended between.
function grain(width: number, height: number, cell: number, seed: number): (x: number, y: number) => number {
  const next = random(seed);
  const columns = Math.ceil(width / cell) + 2;
  const rows = Math.ceil(height / cell) + 2;
  const grid = Array.from({ length: columns * rows }, next);
  const at = (column: number, row: number) => grid[row * columns + column] ?? 0;
  return (x, y) => {
    const column = Math.floor(x / cell);
    const row = Math.floor(y / cell);
    const u = x / cell - column;
    const v = y / cell - row;
    const top = at(column, row) * (1 - u) + at(column + 1, row) * u;
    const bottom = at(column, row + 1) * (1 - u) + at(column + 1, row + 1) * u;
    return top * (1 - v) + bottom * v;
  };
}

function draw(width: number, height: number, dissolve: number, side: Side): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return '';
  if (side === 'end') context.setTransform(-1, 0, 0, 1, width, 0); // drawn for the start, then mirrored

  // The solid part ends dissolve in from the top and the inner side. Past it,
  // a wavy line runs halfway through the dissolve, round the corner and down
  // to what the pool stands on, and its shadow, blurred, fades from solid at
  // the solid part to nothing at the pool's edge. The shape itself is drawn
  // far off the canvas, so that only its shadow lands on it.
  const corner = { x: width - dissolve, y: dissolve };
  const out = dissolve / 2; // from the solid part to the line
  const wave = swell(7, dissolve * 0.18);
  const far = 1e4;
  const points: [number, number][] = [];
  const along = (x: number, y: number, normalX: number, normalY: number, at: number) => {
    const by = out + wave(at);
    points.push([x + normalX * by - far, y + normalY * by]);
  };
  for (let x = -dissolve * 2; x <= corner.x; x += 2) along(x, corner.y, 0, -1, x);
  const turn = (out * Math.PI) / 2;
  for (let angle = -Math.PI / 2; angle < 0; angle += 2 / out)
    along(corner.x, corner.y, Math.cos(angle), Math.sin(angle), corner.x + out * (angle + Math.PI / 2));
  for (let y = corner.y; y <= height + dissolve; y += 2) along(corner.x, y, 1, 0, corner.x + turn + y - corner.y);
  context.beginPath();
  context.moveTo(-dissolve * 2 - far, height + dissolve);
  for (const [x, y] of points) context.lineTo(x, y);
  context.closePath();
  context.shadowColor = '#000';
  context.shadowBlur = dissolve * 0.3; // fades over about as far either side of the line
  context.shadowOffsetX = side === 'end' ? -far : far; // mirrored, the offset runs the other way
  context.fill();

  // Grain where the wash thins out, and none where it is solid.
  const image = context.getImageData(0, 0, width, height);
  const texture = grain(width, height, 9, 23);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4 + 3;
      const alpha = (image.data[index] ?? 0) / 255;
      image.data[index] = 255 * alpha * (1 - 0.45 * (1 - alpha) * texture(x, y));
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

export function wash(side: Side): (pool: HTMLElement) => () => void {
  return (pool) => {
    let frame = 0;
    const paint = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const width = Math.ceil(pool.offsetWidth);
        const height = Math.ceil(pool.offsetHeight);
        const dissolve = parseFloat(getComputedStyle(pool).getPropertyValue('--dissolve')) || 32;
        if (!width || !height) return;
        pool.style.maskImage = `url(${draw(width, height, dissolve, side)})`;
      });
    };
    const resized = new ResizeObserver(paint);
    resized.observe(pool);
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
    };
  };
}
