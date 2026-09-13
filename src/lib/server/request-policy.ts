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
    if (!hosts.has(request.headers.get('host')?.trim().toLowerCase() ?? ''))
      return Response.json({ error: 'Unrecognized Host header' }, { status: 403 });
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      const origin = request.headers.get('origin'),
        site = request.headers.get('sec-fetch-site');
      if (
        (origin && !origins.has(origin.toLowerCase())) ||
        (site && !['same-origin', 'same-site', 'none'].includes(site))
      )
        return Response.json({ error: 'Cross-origin requests are not allowed' }, { status: 403 });
    }
  };
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
