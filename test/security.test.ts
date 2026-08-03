import { describe, expect, test } from 'vitest';
import { isSafeExternalUrl, sanitizeThemeName } from '../lib/security.ts';

describe('sanitizeThemeName', () => {
  test('accepts safe names', () => {
    expect(sanitizeThemeName('default')).toBe('default');
    expect(sanitizeThemeName('newspaper_2026')).toBe('newspaper_2026');
    expect(sanitizeThemeName('high-contrast')).toBe('high-contrast');
  });

  test('rejects unsafe names', () => {
    expect(sanitizeThemeName('../etc/passwd')).toBeNull();
    expect(sanitizeThemeName('../../../tmp/evil')).toBeNull();
    expect(sanitizeThemeName('night mode')).toBeNull();
    expect(sanitizeThemeName('')).toBeNull();
    expect(sanitizeThemeName(null)).toBeNull();
  });
});

describe('isSafeExternalUrl', () => {
  test('accepts normal public https URL', () => {
    const out = isSafeExternalUrl('https://example.com/feed.xml');
    expect(out.ok).toBe(true);
  });

  test('rejects non-http protocols', () => {
    expect(isSafeExternalUrl('file:///etc/passwd').ok).toBe(false);
    expect(isSafeExternalUrl('ftp://example.com/file').ok).toBe(false);
  });

  test('rejects localhost and private ranges', () => {
    expect(isSafeExternalUrl('http://localhost:8080').ok).toBe(false);
    expect(isSafeExternalUrl('http://localhost.').ok).toBe(false);
    expect(isSafeExternalUrl('http://127.0.0.1').ok).toBe(false);
    expect(isSafeExternalUrl('http://192.168.0.10').ok).toBe(false);
    expect(isSafeExternalUrl('http://10.0.1.2').ok).toBe(false);
    expect(isSafeExternalUrl('http://172.16.0.1').ok).toBe(false);
    expect(isSafeExternalUrl('http://[::1]').ok).toBe(false);
    expect(isSafeExternalUrl('http://[fc00::1]').ok).toBe(false);
    expect(isSafeExternalUrl('http://[::ffff:7f00:1]').ok).toBe(false);
    expect(isSafeExternalUrl('http://[::ffff:a00:1]').ok).toBe(false);
  });
});
