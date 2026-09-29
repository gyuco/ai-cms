import { describe, expect, it } from 'vitest';
import { fetchDraft } from './preview.ts';

function stub(status: number, body: unknown = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, calls };
}

const base = { publicPath: '/chi-siamo', env: 'prod' as const, sessionToken: 'tok en' };

describe('fetchDraft', () => {
  it('asks cms-api for the latest version, forwarding the session cookie', async () => {
    const { fn, calls } = stub(200, {
      body: { meta: {}, blocks: [] },
      version: 3,
      published: false,
    });
    const result = await fetchDraft({ ...base, baseUrl: 'http://api:3100', fetch: fn });
    expect(result).toEqual({
      status: 'ok',
      body: { meta: {}, blocks: [] },
      version: 3,
      published: false,
    });
    expect(calls[0]!.url).toBe('http://api:3100/_cms/api/preview?path=%2Fchi-siamo&env=prod');
    expect(new Headers(calls[0]!.init?.headers).get('cookie')).toBe('cms_session=tok%20en');
    expect(calls[0]!.init?.cache).toBe('no-store');
  });

  it('asks for a shared node instead of a page', async () => {
    const { fn, calls } = stub(200, { body: { blocks: [] }, version: 1, published: false });
    await fetchDraft({
      env: 'staging',
      sessionToken: 't',
      nodePath: 'site.layouts.header',
      baseUrl: 'http://api:3100',
      fetch: fn,
    });
    expect(calls[0]!.url).toBe(
      'http://api:3100/_cms/api/preview?node=site.layouts.header&env=staging',
    );
  });

  it('maps statuses', async () => {
    expect(await fetchDraft({ ...base, fetch: stub(401).fn })).toEqual({ status: 'denied' });
    expect(await fetchDraft({ ...base, fetch: stub(403).fn })).toEqual({ status: 'denied' });
    expect(await fetchDraft({ ...base, fetch: stub(404).fn })).toEqual({ status: 'not-found' });
    expect((await fetchDraft({ ...base, fetch: stub(500).fn })).status).toBe('error');
    expect((await fetchDraft({ ...base, fetch: stub(200, { nope: 1 }).fn })).status).toBe('error');
  });

  it('reports network failures', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await fetchDraft({ ...base, fetch: failing })).toEqual({
      status: 'error',
      message: 'fetch failed',
    });
  });
});
