import { building } from '$app/environment';
import type { Handle } from '@sveltejs/kit';
import { app } from '$lib/server/app';
import { requestPolicy } from '$lib/server/request-policy';

if (!building) {
  const a = app();
  void a.refresh.start().catch(() => undefined);
  process.once('feedreader:shutdown', async (drained: Promise<void>) => {
    a.events.close();
    await drained;
    await a.close();
  });
}
export const handle: Handle = async ({ event, resolve }) => {
  const started = performance.now();
  const a = app(),
    config = a.config.read();
  const denied = requestPolicy(config, Number(process.env.PORT || config.port))(event.request);
  if (denied) return denied;
  const response = await resolve(event);
  a.log.record('http.request', {
    route: event.route.id ?? 'unmatched',
    method: event.request.method,
    status: response.status,
    durationMs: Math.round(performance.now() - started),
  });
  response.headers.set('server-timing', `app;dur=${(performance.now() - started).toFixed(2)}`);
  if (response.headers.get('content-type')?.includes('text/html')) {
    response.headers.set('cache-control', 'no-cache');
    response.headers.set('x-frame-options', 'DENY');
    response.headers.set('referrer-policy', 'same-origin');
  }
  return response;
};
export const handleError = ({ error }: { error: unknown }) => {
  app().log.record('http.failed', { error: error instanceof Error ? error.message : String(error) });
  return { message: 'Internal server error' };
};
