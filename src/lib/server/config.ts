import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type Config } from '../types';

export const CONFIG_LIMITS = {
  maxBulkOpen: { min: 1, max: 500 },
  port: { min: 1, max: 65535 },
  maxEntries: { min: 100, max: 100000 },
  maxDays: { min: 1, max: 36500 },
};
export function inLimit(value: number, limit: { min: number; max: number }): boolean {
  return Number.isInteger(value) && value >= limit.min && value <= limit.max;
}
export function parseConfig(value: unknown): Config {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid configuration');
  const input = value as Record<string, unknown>;
  const retention = input.retention ?? {};
  if (!retention || typeof retention !== 'object' || Array.isArray(retention))
    throw new Error('Invalid retention settings');
  const config = { ...DEFAULT_CONFIG, ...input, retention: { ...DEFAULT_CONFIG.retention, ...retention } };
  for (const [key, limit] of Object.entries(CONFIG_LIMITS)) {
    const n =
      key === 'maxEntries' || key === 'maxDays'
        ? config.retention[key]
        : config[key as 'port' | 'maxBulkOpen'];
    if (key === 'maxDays' && n === undefined) continue;
    if (typeof n !== 'number' || !inLimit(n, limit)) throw new Error(`Invalid ${key}`);
  }
  if (typeof config.theme !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(config.theme))
    throw new Error('Invalid theme');
  if (!['system', 'light', 'dark'].includes(config.appearance)) throw new Error('Invalid appearance');
  if (
    !Array.isArray(config.trustedOrigins) ||
    config.trustedOrigins.some((origin) => {
      if (typeof origin !== 'string') return true;
      try {
        const url = new URL(origin);
        return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin;
      } catch {
        return true;
      }
    })
  )
    throw new Error('Invalid trustedOrigins');
  for (const key of Object.keys(input))
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new Error(`Unknown setting: ${key}`);
  for (const key of Object.keys(retention))
    if (!['maxEntries', 'maxDays'].includes(key)) throw new Error(`Unknown retention setting: ${key}`);
  return config;
}
export class Configuration {
  readonly file: string;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, 'config.toml');
    if (!existsSync(this.file)) this.save(DEFAULT_CONFIG);
  }
  read(): Config {
    return parseConfig(Bun.TOML.parse(readFileSync(this.file, 'utf8')));
  }
  save(value: unknown): Config {
    const config = parseConfig(value);
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, Bun.TOML.stringify(config)!, { mode: 0o600 });
    renameSync(temporary, this.file);
    return config;
  }
}
