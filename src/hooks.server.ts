import { building } from '$app/environment';
import { json, isHttpError, type Handle } from '@sveltejs/kit';
import { app } from '$lib/server/app';

const trusted = new Set<string>();
const hosts = new Set<string>();
if (!building) {
  const a = app();
  const config = (await a.store.read()).config;
  const port = Number(process.env.PORT || config.port);
  for (const origin of [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
    ...config.trustedOrigins,
  ]) {
    trusted.add(origin);
    hosts.add(new URL(origin).host);
  }
  void a.refresh.start().catch(() => undefined);
  process.once('feedreader:shutdown', async () => {
    a.events.close();
    await a.refresh.completion?.catch(() => undefined);
    await a.log.flush();
  });
}

export const handle: Handle = async ({ event, resolve }) => {
  const started = performance.now();
  const { request, url } = event;
  if (!hosts.has(request.headers.get('host')?.trim().toLowerCase() ?? ''))
    return json({ error: 'Unrecognized Host header' }, { status: 403 });
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    const origin = request.headers.get('origin');
    const site = request.headers.get('sec-fetch-site');
    if (
      (origin && !trusted.has(origin.toLowerCase())) ||
      (site && !['same-origin', 'same-site', 'none'].includes(site))
    )
      return json({ error: 'Cross-origin requests are not allowed' }, { status: 403 });
  }
  const base =
    url.pathname.startsWith('/feedreader') ||
    (request.headers.get('x-forwarded-host') || request.headers.get('host') || '')
      .split(':')[0]
      ?.endsWith('.ts.net')
      ? '/feedreader'
      : '';
  try {
    const response = await resolve(event, {
      transformPageChunk: ({ html }) =>
        base ? html.replace(/(["'])(?:\/|(?:\.\.?\/)+)_app\//g, `$1${base}/_app/`) : html,
    });
    const links = response.headers.get('link');
    if (base && links)
      response.headers.set('link', links.replace(/<(?:\/|(?:\.\.?\/)+)_app\//g, `<${base}/_app/`));
    if (url.pathname.includes('/api/') && response.status >= 400) {
      const value = await response
        .clone()
        .json()
        .catch(() => ({}));
      return json(
        { error: value.error || value.message || response.statusText },
        { status: response.status },
      );
    }
    app().log.record('http.request', {
      route: event.route.id ?? 'unmatched',
      method: request.method,
      status: response.status,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
    });
    response.headers.set('server-timing', `app;dur=${(performance.now() - started).toFixed(2)}`);
    if (response.headers.get('content-type')?.includes('text/html')) {
      response.headers.set('cache-control', 'no-cache');
      response.headers.set('x-frame-options', 'DENY');
      response.headers.set('referrer-policy', 'same-origin');
    }
    return response;
  } catch (e) {
    if (url.pathname.includes('/api/'))
      return json(
        { error: isHttpError(e) ? e.body.message : 'Internal server error' },
        { status: isHttpError(e) ? e.status : 500 },
      );
    throw e;
  }
};
export const handleError = () => {
  app().log.record('http.failed');
  return { message: 'Internal server error' };
};
