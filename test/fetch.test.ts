import { expect, test } from 'bun:test';
import { earliestAfter, readLimited, restFor } from '../src/lib/server/fetch';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('a healthy feed is asked again after 5 minutes', () => {
  expect(earliestAfter({ items: [] }, 0)).toBe(5 * MINUTE);
});

test('a feed can ask for longer with its cache header, up to 6 hours', () => {
  expect(earliestAfter({ items: [], maxAge: 30 * MINUTE }, 0)).toBe(30 * MINUTE);
  expect(earliestAfter({ items: [], maxAge: 2 * DAY }, 0)).toBe(6 * HOUR);
});

test('Retry-After is respected', () => {
  expect(earliestAfter({ items: [], error: 'HTTP 429', retryAfter: 2 * HOUR }, 1)).toBe(2 * HOUR);
});

test('failures back off, doubling up to 6 hours', () => {
  expect(earliestAfter({ items: [], error: 'x' }, 1)).toBe(10 * MINUTE);
  expect(earliestAfter({ items: [], error: 'x' }, 2)).toBe(20 * MINUTE);
  expect(earliestAfter({ items: [], error: 'x' }, 20)).toBe(6 * HOUR);
});

test('quiet feeds rest longer, up to an hour', () => {
  expect(restFor(HOUR, 5 * MINUTE)).toBe(5 * MINUTE);
  expect(restFor(DAY, 5 * MINUTE)).toBe(30 * MINUTE);
  expect(restFor(10 * DAY, 5 * MINUTE)).toBe(HOUR);
});

test('a longer wait the feed asked for still wins over quiet pacing', () => {
  expect(restFor(HOUR, 3 * HOUR)).toBe(3 * HOUR);
});

test('a response bigger than the limit stops being read part way', async () => {
  let sent = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent += 1024;
      controller.enqueue(new Uint8Array(1024));
    },
  });
  await expect(readLimited(new Response(endless), 10 * 1024)).rejects.toThrow('Feed too large');
  await Bun.sleep(10);
  expect(sent).toBeLessThan(20 * 1024);
});

test('a response within the limit is read whole', async () => {
  const data = await readLimited(new Response('<rss></rss>'), 1024);
  expect(new TextDecoder().decode(data)).toBe('<rss></rss>');
});
