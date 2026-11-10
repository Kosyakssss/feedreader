import adapter from '@sveltejs/adapter-bun';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Where the app listens, for `dev` and for the built server alike, from a
  // local .env file. The app is served over plain http on that one address,
  // which the server can't tell by itself.
  const env = { ...loadEnv(mode, process.cwd(), 'LAGAN_'), ...process.env };
  const host = env.LAGAN_HOST ?? '127.0.0.1';
  const port = Number(env.LAGAN_PORT ?? 8789);

  return {
    plugins: [
      sveltekit({
        compilerOptions: {
          // Runes everywhere except in libraries. Can go in Svelte 6.
          runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true),
        },
        adapter: adapter({ envPrefix: 'LAGAN_', precompress: true }),
        paths: { origin: `http://${host}:${port}` },
      }),
    ],
    server: { host, port, strictPort: true },
  };
});
