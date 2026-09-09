import type { Config } from '../types';

export function requestPolicy(config: Config, port: number) {
  const origins = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
    ...config.trustedOrigins,
  ]);
  const hosts = new Set([...origins].map((origin) => new URL(origin).host));
  return (request: Request): Response | undefined => {
    let error: string | undefined;
    if (!hosts.has(request.headers.get('host')?.trim().toLowerCase() ?? ''))
      error = 'Unrecognized Host header';
    else if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      const origin = request.headers.get('origin');
      const site = request.headers.get('sec-fetch-site');
      if (
        (origin && !origins.has(origin.toLowerCase())) ||
        (site && !['same-origin', 'same-site', 'none'].includes(site))
      )
        error = 'Cross-origin requests are not allowed';
    }
    if (error) return Response.json({ error }, { status: 403 });
  };
}
export async function apiError(response: Response, pathname: string): Promise<Response> {
  if (!pathname.includes('/api/') || response.status < 400) return response;
  const value = await response
    .clone()
    .json()
    .catch(() => ({}));
  if (typeof value.error === 'string') return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json');
  return Response.json(
    {
      error:
        value.message ||
        (response.status === 403 ? 'Cross-origin requests are not allowed' : response.statusText),
    },
    { status: response.status, headers },
  );
}
export function acceptsGzip(request: Request): boolean {
  const encodings = new Map(
    (request.headers.get('accept-encoding') ?? '').split(',').map((value) => {
      const [encoding, ...params] = value.trim().toLowerCase().split(';');
      return [
        encoding,
        Number(
          params
            .find((p) => p.trim().startsWith('q='))
            ?.trim()
            .slice(2) ?? 1,
        ),
      ];
    }),
  );
  return (encodings.get('gzip') ?? encodings.get('*') ?? 0) > 0;
}

export function requestBase(request: Request, url: URL): string {
  return /^\/feedreader(?:\/|$)/.test(url.pathname) ||
    (request.headers.get('x-forwarded-host') || request.headers.get('host') || '')
      .split(':')[0]
      ?.endsWith('.ts.net')
    ? '/feedreader'
    : '';
}
