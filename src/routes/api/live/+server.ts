import type { RequestHandler } from './$types';

// Each change to the library as it happens, as server-sent events. The first
// says which change the library is at, so a copy can tell whether it missed
// any while it was away. A comment every so often keeps idle connections open.
export const GET: RequestHandler = ({ locals, request }) => {
  const encoder = new TextEncoder();
  let stop: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text));
      send(`event: at\ndata: ${locals.live.version}\n\n`);
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        stop?.();
        controller.close();
      };
      const unlisten = locals.live.listen((update) => send(`data: ${JSON.stringify(update)}\n\n`), end);
      const beat = setInterval(() => send(': still here\n\n'), 25_000);
      stop = () => {
        unlisten();
        clearInterval(beat);
      };
      request.signal.addEventListener('abort', end);
    },
    cancel: () => stop?.(),
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' },
  });
};
