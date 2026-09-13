import { error, isHttpError, json, type RequestEvent } from '@sveltejs/kit';
import type { EnrichedEntry, EntryState } from '../types';
import { app } from './app';
import { add, remove, importOPML, exportOPML } from './subscriptions';
import { parseConfig } from './config';

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
async function body(request: Request): Promise<unknown> {
  if (!/^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(request.headers.get('content-type') ?? ''))
    error(415, 'Content-Type must be application/json');
  try {
    return await request.json();
  } catch {
    error(400, 'Malformed JSON body');
  }
}
function statePatch(value: unknown): Record<string, Pick<EntryState, 'read' | 'starred'>> {
  if (!record(value) || !record(value.entries)) error(400, 'Invalid state payload');
  return Object.fromEntries(
    Object.entries(value.entries).map(([id, patch]) => {
      if (!record(patch)) error(400, 'Invalid state update');
      const update: Pick<EntryState, 'read' | 'starred'> = {};
      for (const key of ['read', 'starred'] as const)
        if (key in patch) {
          if (typeof patch[key] !== 'boolean') error(400, `Invalid ${key} state`);
          update[key] = patch[key];
        }
      if (!Object.keys(update).length) error(400, 'Empty state update');
      return [id, update];
    }),
  );
}
let cached:
  | { revision: number; entries: EnrichedEntry[]; bytes?: Uint8Array<ArrayBuffer>; etag?: string }
  | undefined;
function entries() {
  const store = app().store;
  if (!cached || cached.revision !== store.revision)
    cached = { revision: store.revision, entries: store.entries() };
  return cached;
}
export async function handleApi(event: RequestEvent): Promise<Response> {
  try {
    return await route(event);
  } catch (cause) {
    const status = isHttpError(cause) ? cause.status : 500;
    if (status === 500)
      app().log.record('http.failed', { error: cause instanceof Error ? cause.message : String(cause) });
    return json({ error: isHttpError(cause) ? cause.body.message : 'Internal server error' }, { status });
  }
}
async function route({ request, params, platform, url }: RequestEvent): Promise<Response> {
  const a = app(),
    path = params.path ?? '',
    method = request.method;
  if (method === 'GET') {
    switch (path) {
      case 'sync':
        return json({
          entries: entries().entries,
          feeds: a.store.health(),
          config: a.config.read(),
          themes: a.themes.list(),
          status: a.refresh.status(),
          eventId: a.events.sequence,
        });
      case 'entries': {
        const feed = url.searchParams.get('feed');
        if (feed) return json(a.store.entries(feed));
        const snapshot = entries();
        snapshot.bytes ??= new TextEncoder().encode(JSON.stringify(snapshot.entries));
        snapshot.etag ??= `W/"${Bun.hash(snapshot.bytes).toString(16)}"`;
        const headers = {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-cache',
          etag: snapshot.etag,
        };
        return new Response(request.headers.get('if-none-match') === snapshot.etag ? null : snapshot.bytes, {
          status: request.headers.get('if-none-match') === snapshot.etag ? 304 : 200,
          headers,
        });
      }
      case 'config':
        return json(a.config.read());
      case 'themes':
        return json(a.themes.list());
      case 'feeds':
        return json(a.store.health());
      case 'feeds/export':
        return new Response(exportOPML(a), {
          headers: {
            'content-type': 'text/xml; charset=utf-8',
            'content-disposition': 'attachment; filename="feedreader.opml"',
          },
        });
      case 'events':
        if (platform) platform.server.timeout(platform.request, 0);
        return a.events.response(request.signal);
      case 'health':
        return json({
          ok: true,
          pid: process.pid,
          startedAt: a.startedAt,
          uptimeSeconds: Math.round(process.uptime()),
          dataDir: a.store.directory,
          port: Number(process.env.PORT || a.config.read().port),
          refreshing: a.refresh.running,
          lastRefreshResult: a.refresh.status(),
        });
    }
    if (path.startsWith('theme/'))
      return a.themes.response(
        path.slice(6).replace(/\.css$/, ''),
        url.searchParams.get('appearance') ?? 'system',
      );
  }
  if (method === 'PUT' && path === 'config') {
    let config;
    try {
      const value = await body(request);
      if (!record(value)) error(400, 'Invalid settings');
      config = parseConfig({ ...a.config.read(), ...value });
      a.themes.validate(config);
    } catch (cause) {
      if (isHttpError(cause)) throw cause;
      error(400, cause instanceof Error ? cause.message : 'Invalid settings');
    }
    a.config.save(config);
    const removedIds = a.store.prune(config.retention);
    a.events.publish({ topics: ['config'], removedIds });
    return json(config);
  }
  if (method === 'POST') {
    if (path === 'state') {
      const updates = statePatch(await body(request));
      let entryStates;
      try {
        entryStates = a.store.mark(updates);
      } catch (cause) {
        if (cause instanceof Error && cause.message.includes('FOREIGN KEY constraint failed'))
          error(400, 'An entry no longer exists');
        throw cause;
      }
      a.events.publish({ topics: [], entryStates });
      return json({ entryStates });
    }
    if (path === 'feeds') {
      platform?.server.timeout(platform.request, 120);
      const value = await body(request);
      if (!record(value) || typeof value.url !== 'string') error(400, 'Invalid feed payload');
      return json(await add(a, value.url), { status: 201 });
    }
    if (path === 'feeds/import') {
      let bytes: Uint8Array;
      try {
        if (request.headers.get('content-type')?.startsWith('multipart/form-data')) {
          const file = (await request.formData()).get('file');
          if (!(file instanceof File)) error(400, 'Missing OPML file');
          bytes = await file.bytes();
        } else bytes = await request.bytes();
      } catch {
        error(400, 'Invalid OPML upload');
      }
      return json(importOPML(a, bytes));
    }
    if (path === 'refresh') {
      let ids: string[] | undefined;
      if (request.headers.get('content-type')?.startsWith('application/json')) {
        const value = await body(request);
        if (
          !record(value) ||
          !Array.isArray(value.feedIds) ||
          !value.feedIds.every((id) => typeof id === 'string')
        )
          error(400, 'Invalid refresh payload');
        ids = value.feedIds;
      }
      void a.refresh.start(ids).catch(() => undefined);
      return json(a.refresh.status(), { status: 202 });
    }
  }
  if (method === 'DELETE' && /^feeds\/[^/]+$/.test(path)) {
    remove(a, decodeURIComponent(path.slice(6)));
    return json({ ok: true });
  }
  const known =
    /^(sync|entries|config|themes|feeds(?:\/[^/]+)?|events|health|refresh|state|theme\/[^/]+)$/.test(path);
  return json({ error: known ? 'Method not allowed' : 'Not found' }, { status: known ? 405 : 404 });
}
