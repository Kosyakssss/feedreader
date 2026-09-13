import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config, Theme } from '../types';

export class Themes {
  constructor(private directory: string) {
    const target = join(directory, 'default.css');
    if (!existsSync(target))
      copyFileSync(resolve(process.env.FEEDREADER_ROOT ?? '.', 'data/default.css'), target);
  }
  list(): Theme[] {
    return readdirSync(this.directory)
      .filter((name) => /^[a-zA-Z0-9_-]+\.css$/.test(name))
      .sort()
      .map((file) => {
        const css = readFileSync(join(this.directory, file), 'utf8');
        const scheme = /color-scheme\s*:\s*((?:light|dark)(?:\s+(?:light|dark))?)\s*;/i.exec(css)?.[1];
        if (!scheme) throw new Error(`${file} must declare color-scheme: light, dark, or light dark`);
        return {
          name: file.slice(0, -4),
          appearances: scheme.toLowerCase().split(/\s+/) as Theme['appearances'],
        };
      });
  }
  validate(config: Config): void {
    const theme = this.list().find((theme) => theme.name === config.theme);
    if (!theme) throw new Error(`Theme not found: ${config.theme}`);
    if (config.appearance !== 'system' && !theme.appearances.includes(config.appearance))
      throw new Error(`${config.theme} does not have a ${config.appearance} appearance`);
  }
  response(name: string, appearance: string): Response {
    const theme = this.list().find((theme) => theme.name === name);
    if (!theme) return new Response('Theme not found', { status: 404 });
    if (!['system', ...theme.appearances].includes(appearance))
      return new Response('Invalid appearance', { status: 400 });
    const file = Bun.file(join(this.directory, `${name}.css`));
    const content =
      name === 'default' && appearance === 'system'
        ? file
        : (name === 'default' ? '' : readFileSync(join(this.directory, 'default.css'), 'utf8')) +
          readFileSync(join(this.directory, `${name}.css`), 'utf8') +
          (appearance === 'system' ? '' : `\n:root { color-scheme: ${appearance}; }`);
    return new Response(content, {
      headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' },
    });
  }
}
