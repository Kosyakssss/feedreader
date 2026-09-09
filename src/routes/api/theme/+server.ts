import { join } from 'node:path';
import { app } from '$lib/server/app';
const names: Record<string, string> = {
  bg: 'background',
  'bg-card': 'surface',
  'bg-hover': 'surface-hover',
  'bg-nav': 'navigation-background',
  text: 'foreground',
  'text-muted': 'muted',
  'text-link': 'link',
  'on-accent': 'accent-foreground',
  'control-bg': 'field-background',
  'focus-ring': 'field-focus-ring',
  overlay: 'scrim',
  selection: 'selection-background',
  'selection-text': 'selection-foreground',
  star: 'star-accent',
  font: 'font-sans',
  'font-size': 'text-base',
  transition: 'duration-default',
};
export const GET = async () => {
  const { store } = app();
  const name = store.config().theme || 'system';
  const css = await Bun.file(join(store.directory, 'themes', `${name}.css`))
    .text()
    .catch(() => '');
  return new Response(
    css.replace(/--([a-z][a-z0-9-]*)/g, (token, name) => (names[name] ? `--${names[name]}` : token)),
    { headers: { 'content-type': 'text/css', 'cache-control': 'no-cache' } },
  );
};
