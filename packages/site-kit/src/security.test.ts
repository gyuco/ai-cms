import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, generateNonce, SECURITY_HEADERS } from './security.ts';

describe('generateNonce', () => {
  it('returns distinct base64 values of 128 bits', () => {
    const a = generateNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(generateNonce()).not.toBe(a);
  });
});

describe('contentSecurityPolicy', () => {
  it('allows scripts only with the nonce and what they load', () => {
    const csp = contentSecurityPolicy('abc');
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic';");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data: https:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
  });

  it("adds 'unsafe-eval' only in development", () => {
    expect(contentSecurityPolicy('abc', { dev: true })).toContain(
      "'strict-dynamic' 'unsafe-eval';",
    );
  });

  it('defines the other security headers', () => {
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    expect(SECURITY_HEADERS['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(SECURITY_HEADERS['Permissions-Policy']).toContain('camera=()');
  });
});
