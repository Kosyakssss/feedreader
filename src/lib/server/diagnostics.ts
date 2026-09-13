import { createWriteStream, mkdirSync, readdirSync, unlinkSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

export class Diagnostics {
  private day = '';
  private writer?: WriteStream;
  private timer: ReturnType<typeof setInterval>;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    this.rotate();
    this.timer = setInterval(() => {
      if (this.day !== new Date().toISOString().slice(0, 10)) this.rotate();
    }, 60000);
    this.timer.unref();
  }
  private rotate(): void {
    this.writer?.end();
    this.day = new Date().toISOString().slice(0, 10);
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    for (const name of readdirSync(this.directory))
      if (/^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(7, 17) <= cutoff)
        unlinkSync(join(this.directory, name));
    this.writer = createWriteStream(join(this.directory, `events-${this.day}.jsonl`), {
      flags: 'a',
      mode: 0o600,
    });
    this.writer.on('error', (error) => console.error('Diagnostic log:', error.message));
  }
  record(event: string, details: Record<string, string | number | boolean | null> = {}): void {
    if (this.day !== new Date().toISOString().slice(0, 10)) this.rotate();
    this.writer?.write(JSON.stringify({ time: new Date().toISOString(), event, ...details }) + '\n');
  }
  async flush(): Promise<void> {
    clearInterval(this.timer);
    await new Promise<void>((resolve) => (this.writer ? this.writer.end(resolve) : resolve()));
  }
}
