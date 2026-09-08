import { mkdir, rename, stat, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
export class Diagnostics {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  record(event: string, details: Record<string, string | number | boolean | null> = {}): void {
    const line = JSON.stringify({ time: new Date().toISOString(), event, ...details }) + '\n';
    this.queue = this.queue
      .then(async () => {
        await mkdir(this.directory, { recursive: true });
        const file = join(this.directory, 'events.jsonl');
        if (((await stat(file).catch(() => null))?.size ?? 0) > 2 * 1024 * 1024)
          await rename(file, join(this.directory, 'events.previous.jsonl'));
        await appendFile(file, line);
      })
      .catch(() => undefined);
  }
  async flush(): Promise<void> {
    await this.queue;
  }
}
