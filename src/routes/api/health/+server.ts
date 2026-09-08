import { json } from '@sveltejs/kit';
import { app } from '$lib/server/app';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = () => {
  const a = app();
  const status = a.refresh.status();
  return json({
    ok: true,
    pid: process.pid,
    startedAt: a.startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    dataDir: a.store.directory,
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 8787),
    refreshing: a.refresh.running,
    lastRefreshResult: status.finishedAt
      ? { count: status.count, finishedAt: status.finishedAt, error: status.error }
      : null,
  });
};
