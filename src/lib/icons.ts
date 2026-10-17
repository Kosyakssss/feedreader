const ICON_NAMES = [
  'bookmark',
  'check',
  'circle',
  'circle-filled',
  'close',
  'external-link',
  'menu',
  'refresh',
  'star',
  'star-filled',
  'trash',
] as const;
export type IconName = (typeof ICON_NAMES)[number];
export const symbols: Record<IconName, string> = {
  bookmark: '<path d="M5.25 3.25h9.5v13.5L10 13.8l-4.75 2.95V3.25Z"/>',
  check: '<path d="m4.25 10.25 3.65 3.65 7.85-8.15"/>',
  circle: '<circle cx="10" cy="10" r="4.25"/>',
  'circle-filled': '<circle cx="10" cy="10" r="3.75" fill="currentColor" stroke="none"/>',
  close: '<path d="m5.25 5.25 9.5 9.5m0-9.5-9.5 9.5"/>',
  'external-link':
    '<path d="M11 4.5h4.5V9m-.25-4.25L9 11m4.5-.5v4a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h4"/>',
  menu: '<path d="M4 6h12M4 10h12M4 14h12"/>',
  refresh: '<path d="M15.55 7.25A6 6 0 1 0 16 11m-.45-3.75V3.8m0 3.45H12.1"/>',
  star: '<path d="m10 2.75 2.2 4.45 4.9.72-3.55 3.45.84 4.88L10 13.95l-4.39 2.3.84-4.88L2.9 7.92l4.9-.72L10 2.75Z"/>',
  'star-filled':
    '<path d="m10 2.75 2.2 4.45 4.9.72-3.55 3.45.84 4.88L10 13.95l-4.39 2.3.84-4.88L2.9 7.92l4.9-.72L10 2.75Z" fill="currentColor"/>',
  trash: '<path d="M4.75 6.25h10.5m-8.8 0 .55 9h6l.55-9M8 6.25V4.5h4v1.75M8.5 8.75v4.5m3-4.5v4.5"/>',
};
export function faviconDataUri(): string {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" fill="#fffcf0"/><path d="M5.25 3.25h9.5v13.5L10 13.8l-4.75 2.95V3.25Z" fill="#205ea6"/></svg>';
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
