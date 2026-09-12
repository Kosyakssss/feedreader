export function internalPath(path: string): string {
  return path.replace(/^\/feedreader(?=\/|$)/, '') || '/';
}
export function externalPath(path: string): string {
  return (
    (typeof location !== 'undefined' && /^\/feedreader(?:\/|$)/.test(location.pathname)
      ? '/feedreader'
      : '') + path
  );
}
