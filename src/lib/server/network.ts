import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { isNonPublicAddress, isSafeExternalUrl } from './security';
const MAX_REDIRECTS = 5;
export async function safeFetchExternal(
  rawUrl: string,
  initial: BunFetchRequestInit = {},
): Promise<Response> {
  let current = new URL(rawUrl);
  let init = initial;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const addresses = await validatedAddresses(current);
    const response = await fetchFromValidatedAddress(current, addresses, init);
    if (!isRedirect(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    await discardResponseBody(response);
    current = new URL(location, current);
    init = redirectedRequestInit(init, response.status);
  }
  throw new Error('Too many redirects');
}

async function validatedAddresses(url: URL): Promise<readonly string[]> {
  const safe = isSafeExternalUrl(url.href);
  if (!safe.ok) throw new Error(safe.reason);
  const hostname = normalizedHostname(url.hostname);
  if (isIP(hostname)) {
    if (isNonPublicAddress(hostname)) throw new Error('Non-public IP addresses are not allowed');
    return [hostname];
  }
  const records = await Bun.dns.lookup(hostname);
  if (records.length === 0) throw new Error('Hostname did not resolve');
  const addresses = [...new Set(records.map((record) => normalizedHostname(record.address)))];
  if (addresses.some((address) => !isIP(address))) throw new Error('Hostname resolved to an invalid address');
  if (addresses.some(isNonPublicAddress)) throw new Error('Host resolves to a non-public IP address');
  return addresses;
}
async function fetchFromValidatedAddress(
  original: URL,
  addresses: readonly string[],
  init: BunFetchRequestInit,
): Promise<Response> {
  const hostname = normalizedHostname(original.hostname);
  if (isIP(hostname)) return fetch(original.href, { ...init, redirect: 'manual' });
  let lastError: unknown;
  for (const address of addresses) {
    const target = new URL(original);
    target.hostname = isIP(address) === 6 ? `[${address}]` : address;
    const headers = new Headers(init.headers);
    headers.set('host', original.host);
    const tls =
      original.protocol === 'https:'
        ? {
            ...init.tls,
            serverName: hostname,
            checkServerIdentity: (
              _requestedHostname: string,
              certificate: Parameters<typeof checkServerIdentity>[1],
            ) => checkServerIdentity(hostname, certificate),
          }
        : init.tls;
    try {
      return await fetch(target.href, {
        ...init,
        headers,
        redirect: 'manual',
        ...(tls ? { tls } : {}),
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('Could not connect to resolved host');
}
function redirectedRequestInit(init: BunFetchRequestInit, status: number): BunFetchRequestInit {
  const method = (init.method ?? 'GET').toUpperCase();
  if (status !== 303 && !((status === 301 || status === 302) && method === 'POST')) return init;
  const headers = new Headers(init.headers);
  headers.delete('content-length');
  headers.delete('content-type');
  return { ...init, method: 'GET', body: undefined, headers };
}
function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
function normalizedHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase();
}
export async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {}
}
