const SERVE_BASE_PATH = '/feedreader';

function basePathForLocation(pathname = location.pathname): string {
  return pathname === SERVE_BASE_PATH || pathname.startsWith(`${SERVE_BASE_PATH}/`)
    ? SERVE_BASE_PATH
    : '';
}

export function externalPath(path: string): string {
  const basePath = basePathForLocation();
  if (!basePath) return path;
  return path === '/' ? `${basePath}/` : `${basePath}${path}`;
}

export function internalPath(pathname: string): string {
  const basePath = basePathForLocation(pathname);
  if (!basePath) return pathname;
  if (pathname === basePath) return '/';
  return pathname.slice(basePath.length) || '/';
}

export function pushRoute(path: string): void {
  history.pushState({}, '', externalPath(path));
}
