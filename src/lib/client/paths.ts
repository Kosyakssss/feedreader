export function internalPath(path: string): string {
  return path.replace(/^\/feedreader(?=\/|$)/, '') || '/';
}
export function externalPath(path: string): string {
  const base =
    typeof location !== 'undefined' && /^\/feedreader(?:\/|$)/.test(location.pathname) ? '/feedreader' : '';
  return base + (path === '/' ? '/' : path);
}
