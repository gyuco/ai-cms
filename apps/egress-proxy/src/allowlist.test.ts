import { describe, expect, it } from 'vitest';
import { isAllowed, parseAllowlist, parseConnectTarget } from './allowlist.ts';

describe('allowlist', () => {
  const list = parseAllowlist(' api.anthropic.com, .npmjs.org ,,');

  it('parses and normalizes entries', () => {
    expect(list).toEqual(['api.anthropic.com', '.npmjs.org']);
  });

  it('matches exact hosts only for plain entries', () => {
    expect(isAllowed('api.anthropic.com', list)).toBe(true);
    expect(isAllowed('API.Anthropic.com.', list)).toBe(true);
    expect(isAllowed('evil.api.anthropic.com', list)).toBe(false);
    expect(isAllowed('anthropic.com', list)).toBe(false);
  });

  it('matches a domain and its subdomains for dotted entries', () => {
    expect(isAllowed('npmjs.org', list)).toBe(true);
    expect(isAllowed('registry.npmjs.org', list)).toBe(true);
    expect(isAllowed('notnpmjs.org', list)).toBe(false);
  });

  it('denies everything with an empty list', () => {
    expect(isAllowed('api.anthropic.com', [])).toBe(false);
  });
});

describe('parseConnectTarget', () => {
  it('accepts host:443 only', () => {
    expect(parseConnectTarget('api.anthropic.com:443')).toEqual({
      host: 'api.anthropic.com',
      port: 443,
    });
    expect(parseConnectTarget('api.anthropic.com:80')).toBeNull();
    expect(parseConnectTarget('127.0.0.1:22')).toBeNull();
    expect(parseConnectTarget('garbage')).toBeNull();
  });
});
