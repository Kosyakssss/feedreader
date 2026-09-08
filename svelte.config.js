import adapter from 'svelte-adapter-bun';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    csp: {
      directives: {
        'default-src': ['self'],
        'script-src': ['self'],
        'style-src': ['self'],
        'style-src-attr': ['unsafe-inline'],
        'img-src': ['self', 'data:'],
        'connect-src': ['self'],
        'font-src': ['self'],
        'frame-ancestors': ['none'],
        'base-uri': ['self'],
      },
    },
  },
};
