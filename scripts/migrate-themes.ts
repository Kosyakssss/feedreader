import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
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

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    help: { type: 'boolean' },
  },
  strict: true,
});
if (values.help) {
  console.log(
    'bun run migrate:themes --from <old themes directory> --to <new themes directory>\nConverts CSS token names. The output directory must not exist. Original files remain untouched. Use the converted directory as the new installation’s data/themes directory.',
  );
  process.exit(0);
}
if (!values.from || !values.to) throw new Error('Provide --from and --to theme directories');
const source = resolve(values.from);
const target = resolve(values.to);
const files = readdirSync(source, { withFileTypes: true })
  .filter((file) => file.isFile() && file.name.endsWith('.css'))
  .map((file) => ({
    name: file.name,
    css: readFileSync(join(source, file.name), 'utf8').replace(/--([a-z][a-z0-9-]*)/g, (token, name) =>
      names[name] ? `--${names[name]}` : token,
    ),
  }));
if (!files.length) throw new Error('Source directory contains no CSS theme files');
mkdirSync(dirname(target), { recursive: true });
mkdirSync(target);
try {
  for (const file of files) writeFileSync(join(target, file.name), file.css, { flag: 'wx' });
} catch (error) {
  rmSync(target, { recursive: true, force: true });
  throw error;
}
console.log(`Converted ${files.length} theme files into ${target}. Original files were preserved.`);
