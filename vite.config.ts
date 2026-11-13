import adapter from '@sveltejs/adapter-bun';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Where the app listens, for `dev` and for the built server alike, from a
  // local .env file. Behind a proxy, such as `tailscale serve` giving it HTTPS
  // under a path, SITE_ORIGIN is the address people open and SITE_PATH the
  // path it lives under; the server can't tell either by itself. (Not LAGAN_:
  // the server takes those for its own settings, and refuses any it doesn't
  // know.)
  const env = { ...loadEnv(mode, process.cwd(), ['LAGAN_', 'SITE_']), ...process.env };
  const host = env.LAGAN_HOST ?? '127.0.0.1';
  const port = Number(env.LAGAN_PORT ?? 8789);
  const origin = env.SITE_ORIGIN ?? `http://${host}:${port}`;
  const base = (env.SITE_PATH ?? '').replace(/\/$/, '') as '' | `/${string}`;

  return {
    plugins: [
      sveltekit({
        compilerOptions: {
          // Runes everywhere except in libraries. Can go in Svelte 6.
          runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true),
        },
        adapter: adapter({ envPrefix: 'LAGAN_', precompress: true }),
        paths: { origin, base },
      }),
    ],
    server: { host, port, strictPort: true },
  };
});
