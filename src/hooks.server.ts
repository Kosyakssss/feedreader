import { building, dev } from '$app/environment';
import { json, isHttpError, type Handle } from '@sveltejs/kit';
import { app } from '$lib/server/app';
import { requestPolicy, apiError, requestBase } from '$lib/server/request-policy';

let policy: ReturnType<typeof requestPolicy>;
if (!building) {
  const a = app();
  const config = a.store.config();
  const port = Number(process.env.PORT || config.port);
  if (dev) policy = requestPolicy(config, port);
  void a.refresh.start().catch(() => undefined);
  process.once('feedreader:shutdown', async () => {
    a.events.close();
    await a.refresh.completion?.catch(() => undefined);
    await a.log.flush();
    a.store.close();
  });
}

export const handle: Handle = async ({ event, resolve }) => {
  const started = performance.now();
  const { request, url } = event;
  const denied = policy?.(request);
  if (denied) return denied;
  const base = requestBase(request, url);
  try {
    const response = await resolve(event, {
      transformPageChunk: ({ html }) =>
        base ? html.replace(/(["'])(?:\/|(?:\.\.?\/)+)_app\//g, `$1${base}/_app/`) : html,
    });
    const links = response.headers.get('link');
    if (base && links)
      response.headers.set('link', links.replace(/<(?:\/|(?:\.\.?\/)+)_app\//g, `<${base}/_app/`));
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
    return dev ? apiError(response, url.pathname) : response;
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
