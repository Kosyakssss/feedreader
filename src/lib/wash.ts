// A watercolour wash, drawn once as a mask for a page button's pool of glass.
// The pool runs solid from the screen's edge and from what it stands on, and
// dissolves at its top and inner side: a wavy line, softened, with a little
// grain where the colour thins out. Drawn into a picture at the pool's size,
// and again only when that changes; a mask made of SVG filters is redrawn by
// the browser on every frame the page scrolls under it, which stalls it.

type Side = 'start' | 'end';

// The same waves every time, so a redraw on resize doesn't make them jump.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

// A gentle swell: a few slow waves on top of each other.
function swell(seed: number): (at: number) => number {
  const next = random(seed);
  const waves = [52, 31, 19].map((length) => ({ length, phase: next() * Math.PI * 2, size: 3 + next() * 3 }));
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

  // The solid shape, out past the outer edges, its wavy edges a little inside
  // the dissolve so the blur has room to fade them to nothing at the box.
  const soft = dissolve * 0.45;
  const top = swell(7);
  const inner = swell(11);
  const right = width - dissolve * 0.85;
  const ceiling = dissolve * 0.85;
  const far = 1e4; // drawn this far off the canvas; only its blurred shadow lands on it
  context.beginPath();
  context.moveTo(-dissolve - far, height + dissolve);
  context.lineTo(-dissolve - far, ceiling + top(0));
  for (let x = 0; x <= right; x += 2) context.lineTo(x - far, ceiling + top(x));
  for (let y = ceiling; y <= height + dissolve; y += 2) context.lineTo(right + inner(y) - far, y);
  context.closePath();
  context.shadowColor = '#000';
  context.shadowBlur = soft;
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
