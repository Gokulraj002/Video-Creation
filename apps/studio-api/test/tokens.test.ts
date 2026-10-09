import { describe, expect, it } from 'vitest';
import { API_TOKEN_PREFIX, generateApiToken, hashToken, parseBearerToken } from '../src/lib/tokens';

describe('api tokens', () => {
  it('hashes with sha256 hex', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('generates unique, prefixed, high-entropy tokens', () => {
    const a = generateApiToken();
    const b = generateApiToken();
    expect(a).not.toBe(b);
    expect(a.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(a.length).toBeGreaterThanOrEqual(40);
  });

  it('parses bearer headers strictly', () => {
    const token = generateApiToken();
    expect(parseBearerToken(`Bearer ${token}`)).toBe(token);
    expect(parseBearerToken(`bearer ${token}`)).toBe(token);
    expect(parseBearerToken(undefined)).toBeNull();
    expect(parseBearerToken(token)).toBeNull();
    expect(parseBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
    expect(parseBearerToken('Bearer short')).toBeNull();
    expect(parseBearerToken(`Bearer ${token} extra`)).toBeNull();
    expect(parseBearerToken(`Bearer ${'x'.repeat(600)}`)).toBeNull();
  });
});
