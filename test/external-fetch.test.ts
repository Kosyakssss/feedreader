import { describe, expect, test } from 'bun:test';
import { createExternalFetch, type ExternalFetchRuntime } from '../lib/external-fetch.ts';

function runtime(
  resolve: ExternalFetchRuntime['resolve'],
  fetch: ExternalFetchRuntime['fetch'],
): ExternalFetchRuntime {
  return { resolve, fetch };
}

describe('createExternalFetch', () => {
  test('pins the validated address while preserving HTTP host and TLS identity', async () => {
    const calls: { url: string; host: string | null; serverName?: string }[] = [];
    const externalFetch = createExternalFetch(runtime(
      async hostname => {
        expect(hostname).toBe('feeds.example');
        return [{ address: '93.184.216.34', family: 4 }];
      },
      async (input, init) => {
        calls.push({
          url: String(input),
          host: new Headers(init?.headers).get('host'),
          serverName: init?.tls?.serverName,
        });
        return new Response('ok');
      },
    ));

    expect(await (await externalFetch('https://feeds.example:8443/rss')).text()).toBe('ok');
    expect(calls).toEqual([{
      url: 'https://93.184.216.34:8443/rss',
      host: 'feeds.example:8443',
      serverName: 'feeds.example',
    }]);
  });

  test('rejects a hostname if any resolved address is private', async () => {
    let fetched = false;
    const externalFetch = createExternalFetch(runtime(
      async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      async () => {
        fetched = true;
        return new Response();
      },
    ));

    await expect(externalFetch('https://feeds.example/rss')).rejects.toThrow('non-public IP');
    expect(fetched).toBe(false);
  });

  test('revalidates redirects before making the next connection', async () => {
    const calls: string[] = [];
    const externalFetch = createExternalFetch(runtime(
      async hostname => hostname === 'feeds.example'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '169.254.169.254', family: 4 }],
      async input => {
        calls.push(String(input));
        return new Response(null, { status: 302, headers: { location: 'http://metadata.example/latest' } });
      },
    ));

    await expect(externalFetch('https://feeds.example/rss')).rejects.toThrow('non-public IP');
    expect(calls).toEqual(['https://93.184.216.34/rss']);
  });

  test('tries each already-validated public address after connection failures', async () => {
    const calls: string[] = [];
    const externalFetch = createExternalFetch(runtime(
      async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ],
      async input => {
        calls.push(String(input));
        if (calls.length === 1) throw new Error('unreachable');
        return new Response('second address');
      },
    ));

    expect(await (await externalFetch('https://feeds.example/rss')).text()).toBe('second address');
    expect(calls).toEqual([
      'https://93.184.216.34/rss',
      'https://[2606:2800:220:1:248:1893:25c8:1946]/rss',
    ]);
  });
});
