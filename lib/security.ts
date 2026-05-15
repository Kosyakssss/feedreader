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

function parseIPv6Groups(host: string): number[] | null {
  let h = host.toLowerCase();

  if (h.includes('.')) {
    const lastColon = h.lastIndexOf(':');
    if (lastColon === -1) return null;
    const ipv4 = h.slice(lastColon + 1);
    if (isIP(ipv4) !== 4) return null;
    const [a, b, c, d] = ipv4.split('.').map(Number);
    h = `${h.slice(0, lastColon)}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const compressed = h.split('::');
  if (compressed.length > 2) return null;

  const left = compressed[0] ? compressed[0].split(':') : [];
  const right = compressed.length === 2 && compressed[1] ? compressed[1].split(':') : [];
  if (compressed.length === 1 && left.length !== 8) return null;

  const parseGroup = (group: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    return Number.isFinite(value) && value >= 0 && value <= 0xffff ? value : null;
  };

  const leftGroups = left.map(parseGroup);
  const rightGroups = right.map(parseGroup);
  if (leftGroups.some(g => g === null) || rightGroups.some(g => g === null)) return null;

  const missing = 8 - leftGroups.length - rightGroups.length;
  if (missing < 0 || (compressed.length === 1 && missing !== 0)) return null;
  return [
    ...(leftGroups as number[]),
    ...Array.from({ length: missing }, () => 0),
    ...(rightGroups as number[]),
  ];
}

function isPrivateIPv6(host: string): boolean {
  const groups = parseIPv6Groups(host);
  if (!groups) return true;

  if (groups.every(group => group === 0)) return true; // Unspecified
  if (groups.slice(0, 7).every(group => group === 0) && groups[7] === 1) return true; // Loopback
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // Unique local fc00::/7
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // Link-local fe80::/10
  if ((groups[0] & 0xff00) === 0xff00) return true; // Multicast ff00::/8

  const firstFiveZero = groups.slice(0, 5).every(group => group === 0);
  if (firstFiveZero && groups[5] === 0xffff) {
    const mapped = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isPrivateIPv4(mapped);
  }

  const firstSixZero = groups.slice(0, 6).every(group => group === 0);
  if (firstSixZero) {
    const compatible = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isPrivateIPv4(compatible);
  }

  return false;
}

function normalizeHostname(host: string): string {
  const lower = host.toLowerCase();
  const unbracketed = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
  return unbracketed.replace(/\.+$/, '');
}

export function isPrivateAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return isPrivateIPv4(normalized);
  if (ipVersion === 6) return isPrivateIPv6(normalized);
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

  const normalizedHost = normalizeHostname(parsed.hostname);
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
