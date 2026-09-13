import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
export default defineConfig({
  plugins: [
    sveltekit(),
    {
      name: 'feedreader-port',
      configureServer(server) {
        process.env.PORT = String(server.config.server.port ?? 5173);
      },
    },
  ],
  server: { host: '127.0.0.1', strictPort: true },
  build: { target: 'es2022' },
});
