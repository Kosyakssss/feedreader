import { mkdir, open, rename, unlink, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FeedsFile, CacheFile, StateFile, Config } from '../types';
import {
  normalizeFeedsFile,
  normalizeCacheFile,
  normalizeStateShape,
  normalizeStateFile,
  normalizeConfig,
  mergeStateEntry,
} from './normalize';
export interface Snapshot {
  feeds: FeedsFile;
  cache: CacheFile;
  state: StateFile;
  config: Config;
}
const keys = ['feeds', 'cache', 'state', 'config'] as const;
type Key = (typeof keys)[number];
const normalize = {
  feeds: normalizeFeedsFile,
  cache: normalizeCacheFile,
  state: normalizeStateShape,
  config: normalizeConfig,
};
export class Storage {
  private queue: Promise<unknown> = Promise.resolve();
  private recovered = false;
  revision = 0;
  private snapshot: { revision: number; data: Snapshot } | undefined;
  private cached = new Map<
    Key,
    {
      stamp: string;
      value: unknown;
    }
  >();
  constructor(readonly directory: string) {}
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }
  query<T>(project: (data: Snapshot) => T): Promise<T> {
    return this.exclusive(async () => project(await this.load()));
  }
  async read(): Promise<Snapshot> {
    return this.query((data) => structuredClone(data));
  }
  async change<T>(changed: readonly Key[], work: (data: Snapshot) => T | Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const previous = await this.load();
      const data = {
        ...previous,
        ...Object.fromEntries(changed.map((key) => [key, structuredClone(previous[key])])),
      };
      const result = await work(data);
      const files = Object.fromEntries(
        changed
          .filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(data[key]))
          .map((key) => [`${key}.json`, data[key]]),
      );
      if (Object.keys(files).length) {
        this.recovered = false;
        await this.atomic('transaction.json', { files });
        for (const [name, value] of Object.entries(files)) await this.atomic(name, value);
        await unlink(join(this.directory, 'transaction.json'));
        await this.syncDirectory();
        this.recovered = true;
        this.cached.clear();
      }
      return result;
    });
  }
  async mergeConflicts(): Promise<void> {
    const files = (await readdir(this.directory).catch(() => [] as string[])).filter((name) =>
      /^state\.sync-conflict-.*\.json$/.test(name),
    );
    if (!files.length) return;
    await this.change(['state'], async (data) => {
      for (const name of files) {
        const incoming = normalizeStateFile(normalizeStateShape(await this.json(name)), data.cache);
        for (const [id, value] of Object.entries(incoming))
          data.state[id] = mergeStateEntry(data.state[id], value);
      }
    });
    await Promise.all(files.map((name) => unlink(join(this.directory, name))));
    await this.syncDirectory();
  }
  private async load(): Promise<Snapshot> {
    await this.recover();
    const data = Object.fromEntries(
      await Promise.all(
        keys.map(async (key) => {
          const info = await stat(join(this.directory, `${key}.json`)).catch((error) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          const stamp = info ? `${info.ino}:${info.size}:${info.mtimeMs}` : 'missing';
          let entry = this.cached.get(key);
          if (entry?.stamp !== stamp) {
            this.revision++;
            entry = { stamp, value: normalize[key](await this.json(`${key}.json`)) };
            this.cached.set(key, entry);
          }
          return [key, entry!.value];
        }),
      ),
    ) as unknown as Snapshot;
    if (this.snapshot?.revision !== this.revision)
      this.snapshot = {
        revision: this.revision,
        data: { ...data, state: normalizeStateFile(data.state, data.cache) },
      };
    return this.snapshot.data;
  }
  private async json(name: string): Promise<unknown> {
    try {
      const raw = await Bun.file(join(this.directory, name)).json();
      if (raw && typeof raw === 'object' && '$feedreader' in raw) {
        if (raw.$feedreader !== 1) throw new Error(`Unsupported storage version in ${name}`);
        return raw.data;
      }
      return raw;
    } catch (error) {
      if (
        (
          error as {
            code?: string;
          }
        ).code === 'ENOENT'
      )
        return undefined;
      throw error;
    }
  }
  private async recover(): Promise<void> {
    if (this.recovered) return;
    const journal = (await this.json('transaction.json')) as
      | {
          files?: Record<string, unknown>;
        }
      | undefined;
    if (journal) {
      if (!journal.files || typeof journal.files !== 'object') throw new Error('Invalid transaction journal');
      for (const [name, value] of Object.entries(journal.files)) {
        const key = name.replace('.json', '') as Key;
        if (!keys.includes(key) || name !== `${key}.json`) throw new Error('Invalid transaction filename');
        await this.atomic(name, normalize[key](value));
      }
      await unlink(join(this.directory, 'transaction.json'));
      await this.syncDirectory();
      this.cached.clear();
    }
    this.recovered = true;
  }
  private async atomic(name: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = join(this.directory, name);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx');
      try {
        await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
      await this.syncDirectory();
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  private async syncDirectory(): Promise<void> {
    const handle = await open(this.directory, 'r');
    try {
      await handle.sync();
    } catch (error) {
      if (
        !['EINVAL', 'ENOTSUP', 'EPERM'].includes(
          (
            error as {
              code: string;
            }
          ).code,
        )
      )
        throw error;
    } finally {
      await handle.close();
    }
  }
}
