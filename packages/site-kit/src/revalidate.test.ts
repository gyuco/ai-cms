import { describe, expect, it } from 'vitest';
import { isAuthorized, parseRevalidateBody, requestRevalidation } from './revalidate.ts';

describe('isAuthorized', () => {
  it('accepts only the exact bearer token', () => {
    expect(isAuthorized('Bearer s3cret', 's3cret')).toBe(true);
    expect(isAuthorized('bearer s3cret', 's3cret')).toBe(true);
    expect(isAuthorized('Bearer s3cre', 's3cret')).toBe(false);
    expect(isAuthorized('Bearer s3cret2', 's3cret')).toBe(false);
    expect(isAuthorized('s3cret', 's3cret')).toBe(false);
    expect(isAuthorized(null, 's3cret')).toBe(false);
    expect(isAuthorized('Bearer ', '')).toBe(false);
  });
});

describe('parseRevalidateBody', () => {
  it('normalizes page paths and keeps "*"', () => {
    expect(parseRevalidateBody({ paths: ['/', '/chi-siamo/', '/blog/primo', '*', '/'] })).toEqual({
      ok: true,
      paths: ['/', '/chi-siamo', '/blog/primo', '*'],
    });
  });

  it('rejects malformed bodies', () => {
    expect(parseRevalidateBody(null).ok).toBe(false);
    expect(parseRevalidateBody({}).ok).toBe(false);
    expect(parseRevalidateBody({ paths: [] }).ok).toBe(false);
    expect(parseRevalidateBody({ paths: ['chi-siamo'] }).ok).toBe(false);
    expect(parseRevalidateBody({ paths: ['/A'] }).ok).toBe(false);
    expect(parseRevalidateBody({ paths: [42] }).ok).toBe(false);
  });
});

describe('requestRevalidation', () => {
  it('posts the paths with the token', async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const result = await requestRevalidation({
      siteUrl: 'http://site-prod:3000/',
      token: 'tok',
      paths: ['/chi-siamo'],
      fetch: (async (url: string, init?: RequestInit) => {
        seen = { url, init };
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    expect(result).toEqual({ ok: true, status: 200 });
    expect(seen?.url).toBe('http://site-prod:3000/__cms/revalidate');
    expect(seen?.init?.method).toBe('POST');
    expect(new Headers(seen?.init?.headers).get('authorization')).toBe('Bearer tok');
    expect(JSON.parse(String(seen?.init?.body))).toEqual({ paths: ['/chi-siamo'] });
  });

  it('reports failures without throwing', async () => {
    const denied = await requestRevalidation({
      siteUrl: 'http://x',
      token: 't',
      paths: ['*'],
      fetch: (async () => new Response('', { status: 401 })) as typeof fetch,
    });
    expect(denied).toEqual({ ok: false, status: 401, error: 'HTTP 401' });
    const down = await requestRevalidation({
      siteUrl: 'http://x',
      token: 't',
      paths: ['*'],
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    expect(down).toEqual({ ok: false, error: 'fetch failed' });
  });
});
