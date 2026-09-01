import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { isNonPublicAddress, isSafeExternalUrl } from './security.ts';

const MAX_REDIRECTS = 5;

interface ResolvedAddress {
  address: string;
  family: number;
}

export interface ExternalFetchRuntime {
  resolve(hostname: string): Promise<readonly ResolvedAddress[]>;
  fetch(input: string | URL | Request, init?: BunFetchRequestInit): Promise<Response>;
}

export type ExternalFetch = (rawUrl: string, init?: BunFetchRequestInit) => Promise<Response>;

const defaultRuntime: ExternalFetchRuntime = {
  resolve: hostname => lookup(hostname, { all: true, order: 'verbatim' }),
  fetch: (input, init) => globalThis.fetch(input, init),
};

/**
 * Creates an HTTP client that validates every redirect and connects only to
 * addresses returned by that validation lookup. Rewriting the connection URL
 * closes the DNS rebinding gap between checking a hostname and fetching it.
 */
export function createExternalFetch(runtime: ExternalFetchRuntime = defaultRuntime): ExternalFetch {
  return async (rawUrl, initial = {}) => {
    let current = new URL(rawUrl);
    let init = initial;

    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
      const addresses = await validatedAddresses(current, runtime);
      const response = await fetchFromValidatedAddress(current, addresses, init, runtime);
      if (!isRedirect(response.status)) return response;

      const location = response.headers.get('location');
      if (!location) return response;
      await discardResponseBody(response);
      current = new URL(location, current);
      init = redirectedRequestInit(init, response.status);
    }
    throw new Error('Too many redirects');
  };
}

export const safeFetchExternal = createExternalFetch();

async function validatedAddresses(url: URL, runtime: ExternalFetchRuntime): Promise<readonly string[]> {
  const safe = isSafeExternalUrl(url.href);
  if (!safe.ok) throw new Error(safe.reason);

  const hostname = normalizedHostname(url.hostname);
  if (isIP(hostname)) {
    if (isNonPublicAddress(hostname)) throw new Error('Non-public IP addresses are not allowed');
    return [hostname];
  }

  const records = await runtime.resolve(hostname);
  if (records.length === 0) throw new Error('Hostname did not resolve');
  const addresses = [...new Set(records.map(record => normalizedHostname(record.address)))];
  if (addresses.some(address => !isIP(address))) throw new Error('Hostname resolved to an invalid address');
  if (addresses.some(isNonPublicAddress)) throw new Error('Host resolves to a non-public IP address');
  return addresses;
}

async function fetchFromValidatedAddress(
  original: URL,
  addresses: readonly string[],
  init: BunFetchRequestInit,
  runtime: ExternalFetchRuntime,
): Promise<Response> {
  const hostname = normalizedHostname(original.hostname);
  if (isIP(hostname)) return runtime.fetch(original.href, { ...init, redirect: 'manual' });

  let lastError: unknown;
  for (const address of addresses) {
    const target = new URL(original);
    target.hostname = isIP(address) === 6 ? `[${address}]` : address;
    const headers = new Headers(init.headers);
    headers.set('host', original.host);
    const tls = original.protocol === 'https:'
      ? {
          ...init.tls,
          serverName: hostname,
          checkServerIdentity: (_requestedHostname: string, certificate: Parameters<typeof checkServerIdentity>[1]) =>
            checkServerIdentity(hostname, certificate),
        }
      : init.tls;
    try {
      return await runtime.fetch(target.href, { ...init, headers, redirect: 'manual', ...(tls ? { tls } : {}) });
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
  return hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {}
}
