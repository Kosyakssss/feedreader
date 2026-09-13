import { BlockList, isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
  ['100::', 64],
  ['2001:db8::', 32],
] as const)
  blocked.addSubnet(network, prefix, 'ipv6');
export const UA = 'Feedreader/0.1';
export const MAX_DISCOVERY_BYTES = 2 * 1024 * 1024;
function hostname(value: string): string {
  return value
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase();
}
export function isNonPublicAddress(value: string): boolean {
  const address = hostname(value);
  const family = isIP(address);
  if (!family) return false;
  if (blocked.check(address, family === 4 ? 'ipv4' : 'ipv6')) return true;
  if (family === 4) return false;
  const normalized = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const [left = '', right] = normalized.split('::');
  const a = left ? left.split(':') : [],
    b = right ? right.split(':') : [];
  const groups = (right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b]).map(
    (n) => Number.parseInt(n, 16),
  );
  let high: number, low: number;
  if (groups[0] === 0x2002) [high, low] = [groups[1]!, groups[2]!];
  else if (groups[0] === 0x2001 && groups[1] === 0) [high, low] = [groups[6]! ^ 0xffff, groups[7]! ^ 0xffff];
  else if ((groups[0] === 0x64 && groups[1] === 0xff9b) || groups.slice(0, 6).every((n) => n === 0))
    [high, low] = [groups[6]!, groups[7]!];
  else return false;
  return blocked.check(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`, 'ipv4');
}
export function isSafeExternalUrl(rawUrl: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'Invalid URL' };
  }
  if (!['http:', 'https:'].includes(url.protocol))
    return { ok: false, reason: 'Only http/https URLs are allowed' };
  if (url.username || url.password) return { ok: false, reason: 'URL credentials are not allowed' };
  const host = hostname(url.hostname);
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    isNonPublicAddress(host)
  )
    return { ok: false, reason: 'Local addresses are not allowed' };
  return { ok: true, url };
}
export async function safeFetchExternal(
  rawUrl: string,
  initial: BunFetchRequestInit = {},
): Promise<Response> {
  let current = new URL(rawUrl),
    init = initial;
  for (let redirect = 0; redirect <= 5; redirect++) {
    const safe = isSafeExternalUrl(current.href);
    if (!safe.ok) throw new Error(safe.reason);
    const host = hostname(current.hostname);
    const addresses = isIP(host)
      ? [host]
      : [...new Set((await Bun.dns.lookup(host)).map((record) => hostname(record.address)))];
    if (!addresses.length || addresses.some((address) => !isIP(address) || isNonPublicAddress(address)))
      throw new Error('Host did not resolve to public addresses');
    const response = await fetchAddress(current, addresses, init);
    if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.has('location'))
      return Object.defineProperty(response, 'url', { value: current.href });
    await discardResponseBody(response);
    const next = new URL(response.headers.get('location')!, current);
    const headers = new Headers(init.headers);
    if (next.origin !== current.origin) {
      headers.delete('authorization');
      headers.delete('cookie');
    }
    const method = (init.method ?? 'GET').toUpperCase();
    if (
      (response.status === 303 && method !== 'HEAD') ||
      ([301, 302].includes(response.status) && method === 'POST')
    ) {
      headers.delete('content-type');
      headers.delete('content-length');
      init = { ...init, method: 'GET', body: undefined };
    }
    init = { ...init, headers };
    current = next;
  }
  throw new Error('Too many redirects');
}
async function fetchAddress(
  original: URL,
  addresses: string[],
  init: BunFetchRequestInit,
): Promise<Response> {
  const host = hostname(original.hostname);
  if (isIP(host)) return fetch(original, { ...init, redirect: 'manual' });
  let lastError: unknown;
  for (const address of addresses) {
    const target = new URL(original);
    target.hostname = isIP(address) === 6 ? `[${address}]` : address;
    const headers = new Headers(init.headers);
    headers.set('host', original.host);
    try {
      return await fetch(target, {
        ...init,
        headers,
        redirect: 'manual',
        ...(original.protocol === 'https:'
          ? {
              tls: {
                ...init.tls,
                serverName: host,
                checkServerIdentity: (
                  _name: string,
                  certificate: Parameters<typeof checkServerIdentity>[1],
                ) => checkServerIdentity(host, certificate),
              },
            }
          : {}),
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('Could not connect to resolved host');
}
export async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {}
}
export async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('Response body too large');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}
export function decodeText(bytes: Uint8Array, contentType = ''): string {
  const encoding = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  return new TextDecoder(encoding).decode(bytes);
}
