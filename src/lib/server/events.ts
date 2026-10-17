import type { SharedEventPayload } from '../types';
export class Events {
  private clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private id = 0;
  private encoder = new TextEncoder();
  get sequence(): number {
    return this.id;
  }
  publish(payload: SharedEventPayload): void {
    const bytes = this.encoder.encode(`id: ${++this.id}\ndata: ${JSON.stringify(payload)}\n\n`);
    for (const client of this.clients) this.send(client, bytes);
  }
  private send(client: ReadableStreamDefaultController<Uint8Array>, bytes: Uint8Array): void {
    try {
      if ((client.desiredSize ?? 0) <= 0) throw new Error('Slow event client');
      client.enqueue(bytes);
    } catch {
      this.clients.delete(client);
      try {
        client.close();
      } catch {}
    }
  }
  response(signal: AbortSignal): Response {
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (client) => {
          this.clients.add(client);
          client.enqueue(this.encoder.encode(`retry: 2000\nid: ${this.id}\ndata: {"topics":["sync"]}\n\n`));
          const timer = setInterval(() => {
            if (!this.clients.has(client)) cleanup();
            else this.send(client, this.encoder.encode(': keepalive\n\n'));
          }, 5000);
          timer.unref();
          cleanup = () => {
            clearInterval(timer);
            this.clients.delete(client);
            signal.removeEventListener('abort', cleanup);
            try {
              client.close();
            } catch {}
          };
          signal.addEventListener('abort', cleanup, { once: true });
          if (signal.aborted) cleanup();
        },
        cancel: () => cleanup(),
      },
      { highWaterMark: 64 },
    );
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
    });
  }
  close(): void {
    for (const client of this.clients) {
      try {
        client.close();
      } catch {}
    }
    this.clients.clear();
  }
}
