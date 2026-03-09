import { isIP } from 'node:net';

export function sanitizeThemeName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return null;
  return name;
}

function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;

  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // Unique local
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true; // Link-local
  if (h.startsWith('ff')) return true; // Multicast

  if (h.startsWith('::ffff:')) {
    const mapped = h.slice(7);
    if (isIP(mapped) === 4) return isPrivateIPv4(mapped);
  }
  return false;
}

export function isSafeExternalUrl(rawUrl: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'Invalid URL' };
  }

  if (!(parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    return { ok: false, reason: 'Only http/https URLs are allowed' };
  }

  const host = parsed.hostname.toLowerCase();
  const normalizedHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (normalizedHost === 'localhost' || normalizedHost.endsWith('.localhost') || normalizedHost.endsWith('.local')) {
    return { ok: false, reason: 'Local hosts are not allowed' };
  }

  const ipVersion = isIP(normalizedHost);
  if (ipVersion === 4 && isPrivateIPv4(normalizedHost)) {
    return { ok: false, reason: 'Private IPv4 addresses are not allowed' };
  }
  if (ipVersion === 6 && isPrivateIPv6(normalizedHost)) {
    return { ok: false, reason: 'Private IPv6 addresses are not allowed' };
  }

  return { ok: true, url: parsed };
}
