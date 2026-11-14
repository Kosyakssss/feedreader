// The app's server: `bun src/server.ts`, or `bun --hot src/server.ts` while
// working on it. Where it listens comes from .env: LAGAN_HOST and LAGAN_PORT,
// and behind a proxy that serves it under a path, such as `tailscale serve`,
// SITE_PATH.
import { start } from '#lib/server/lagan.ts';
import { app } from './app';

const base = (process.env.SITE_PATH ?? '').replace(/\/$/, '');
const server = Bun.serve({
  hostname: process.env.LAGAN_HOST ?? '127.0.0.1',
  port: Number(process.env.LAGAN_PORT ?? 8789),
  ...app(start(), base),
});
console.log(`Lagan at ${new URL(base || '/', server.url)}`);
