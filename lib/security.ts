import { isIP } from 'node:net';

export function sanitizeThemeName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return null;
  return name;
}

export function isSafeObjectKey(key: string): boolean {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

const NON_PUBLIC_IPV4_BLOCKS: ReadonlyArray<readonly [network: number, mask: number]> = [
  [0x00000000, 0xff000000], // 0.0.0.0/8
  [0x0a000000, 0xff000000], // 10.0.0.0/8
  [0x64400000, 0xffc00000], // 100.64.0.0/10
  [0x7f000000, 0xff000000], // 127.0.0.0/8
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16
  [0xac100000, 0xfff00000], // 172.16.0.0/12
  [0xc0000000, 0xffffff00], // 192.0.0.0/24
  [0xc0000200, 0xffffff00], // 192.0.2.0/24
  [0xc0586300, 0xffffff00], // 192.88.99.0/24
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16
  [0xc6120000, 0xfffe0000], // 198.18.0.0/15
  [0xc6336400, 0xffffff00], // 198.51.100.0/24
  [0xcb007100, 0xffffff00], // 203.0.113.0/24
  [0xe0000000, 0xf0000000], // 224.0.0.0/4
];

function parseIPv4(host: string): number | null {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  const [a, b, c, d] = octets as [number, number, number, number];
  return (((a * 256 + b) * 256 + c) * 256 + d) >>> 0;
}

function isNonPublicIPv4(host: string): boolean {
  const address = parseIPv4(host);
  return address === null || NON_PUBLIC_IPV4_BLOCKS.some(([network, mask]) => ((address & mask) >>> 0) === network);
}

function parseIPv6Groups(host: string): number[] | null {
  let h = host.toLowerCase();

  if (h.includes('.')) {
    const lastColon = h.lastIndexOf(':');
    if (lastColon === -1) return null;
    const ipv4 = h.slice(lastColon + 1);
    if (isIP(ipv4) !== 4) return null;
    const octets = ipv4.split('.').map(Number);
    if (octets.length !== 4 || octets.some(n => !Number.isInteger(n))) return null;
    const [a = -1, b = -1, c = -1, d = -1] = octets;
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

function isNonPublicIPv6(host: string): boolean {
  const groups = parseIPv6Groups(host);
  if (!groups) return true;

  const [g0 = -1, g1 = -1, g2 = -1, , , g5 = -1, g6 = -1, g7 = -1] = groups;
  if (groups.every(group => group === 0)) return true; // Unspecified
  if (groups.slice(0, 7).every(group => group === 0) && g7 === 1) return true; // Loopback
  if ((g0 & 0xfe00) === 0xfc00) return true; // Unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // Link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // Deprecated site-local fec0::/10
  if ((g0 & 0xff00) === 0xff00) return true; // Multicast ff00::/8
  if (g0 === 0x0100 && groups.slice(1, 4).every(group => group === 0)) return true; // Discard-only 100::/64
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // Documentation 2001:db8::/32

  // IPv4-embedded transition mechanisms may resolve to non-public IPv4 space.
  if (g0 === 0x0064 && g1 === 0xff9b) { // NAT64 well-known prefix 64:ff9b::/96
    const mapped = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
    return isNonPublicIPv4(mapped);
  }
  if (g0 === 0x2002) { // 6to4 2002::/16 — IPv4 sits in g1:g2
    const embedded = `${(g1 >> 8)}.${g1 & 0xff}.${(g2 >> 8)}.${g2 & 0xff}`;
    return isNonPublicIPv4(embedded);
  }
  if (g0 === 0x2001 && g1 === 0) { // Teredo 2001::/32 — obfuscated client IPv4 in g6:g7
    const mapped = `${(g6 ^ 0xffff) >> 8}.${(g6 ^ 0xffff) & 0xff}.${(g7 ^ 0xffff) >> 8}.${(g7 ^ 0xffff) & 0xff}`;
    return isNonPublicIPv4(mapped);
  }

  const firstFiveZero = groups.slice(0, 5).every(group => group === 0);
  if (firstFiveZero && g5 === 0xffff) {
    const mapped = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
    return isNonPublicIPv4(mapped);
  }

  const firstSixZero = groups.slice(0, 6).every(group => group === 0);
  if (firstSixZero) {
    const compatible = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
    return isNonPublicIPv4(compatible);
  }

  return false;
}

function normalizeHostname(host: string): string {
  const lower = host.toLowerCase();
  const unbracketed = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
  return unbracketed.replace(/\.+$/, '');
}

export function isNonPublicAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return isNonPublicIPv4(normalized);
  if (ipVersion === 6) return isNonPublicIPv6(normalized);
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
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'URL credentials are not allowed' };
  }

  const normalizedHost = normalizeHostname(parsed.hostname);
  if (normalizedHost === 'localhost' || normalizedHost.endsWith('.localhost') || normalizedHost.endsWith('.local')) {
    return { ok: false, reason: 'Local hosts are not allowed' };
  }

  const ipVersion = isIP(normalizedHost);
  if (ipVersion === 4 && isNonPublicIPv4(normalizedHost)) {
    return { ok: false, reason: 'Non-public IPv4 addresses are not allowed' };
  }
  if (ipVersion === 6 && isNonPublicIPv6(normalizedHost)) {
    return { ok: false, reason: 'Non-public IPv6 addresses are not allowed' };
  }

  return { ok: true, url: parsed };
}
