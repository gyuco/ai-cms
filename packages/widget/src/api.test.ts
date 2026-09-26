import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createApi,
  fetchContext,
  logout,
  requestEnvSwitch,
  withQuery,
  type Me,
  type WidgetContext,
} from './api.ts';

const me: Me = {
  user: {
    uid: 1,
    username: 'anna',
    displayName: null,
    email: 'a@x.test',
    mustChangePassword: false,
  },
  env: 'prod',
  csrfToken: 'csrf-1',
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const context: WidgetContext = {
  ...me,
  node: { path: '/site/pages/chi-siamo', kind: 'page', exists: true, version: 3 },
  page: { latestVersion: 2, publishedVersion: 1, hasDraft: true },
};

describe('fetchContext', () => {
  it('returns the session and the page', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, context));
    expect(await fetchContext('/chi-siamo', fetchFn, { cookie: '' })).toEqual(context);
    expect(fetchFn).toHaveBeenCalledWith('/_cms/api/context?path=%2Fchi-siamo', expect.anything());
  });

  it('returns null and expires the cms_ui cookie on 401', async () => {
    const doc = { cookie: 'cms_ui=1' };
    const fetchFn = vi.fn(async () => jsonResponse(401, { error: { code: 'unauthenticated' } }));
    expect(await fetchContext('/', fetchFn, doc)).toBeNull();
    expect(doc.cookie).toMatch(/^cms_ui=;/);
    expect(doc.cookie).toContain('Path=/');
    expect(doc.cookie).toContain('Expires=Thu, 01 Jan 1970');
  });

  it('throws on other errors, keeping the cookie', async () => {
    const doc = { cookie: 'cms_ui=1' };
    const fetchFn = vi.fn(async () => jsonResponse(500, { error: { message: 'Guasto' } }));
    await expect(fetchContext('/', fetchFn, doc)).rejects.toThrow('Guasto');
    expect(doc.cookie).toBe('cms_ui=1');
  });
});

describe('requestEnvSwitch', () => {
  it('asks for the other environment with the CSRF token and returns the URL', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, { url: 'http://staging.localhost/_cms/sso?t=x' }),
    );
    const url = await requestEnvSwitch(me, '/chi-siamo?x=1', fetchFn);
    expect(url).toBe('http://staging.localhost/_cms/sso?t=x');
    const [path, init] = fetchFn.mock.calls[0]!;
    expect(path).toBe('/_cms/api/auth/sso');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('csrf-1');
    expect(JSON.parse(init?.body as string)).toEqual({
      target: 'staging',
      returnTo: '/chi-siamo?x=1',
    });
  });

  it('reports the server message on failure', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(403, { error: { message: 'Negato' } }));
    await expect(requestEnvSwitch(me, '/', fetchFn)).rejects.toEqual(new ApiError(403, 'Negato'));
  });
});

describe('logout', () => {
  it('posts with the CSRF token and treats an expired session as logged out', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(401, {}));
    await expect(logout(me, fetchFn)).resolves.toBeUndefined();
    expect(new Headers(fetchFn.mock.calls[0]![1]?.headers).get('x-csrf-token')).toBe('csrf-1');
  });
});

describe('createApi', () => {
  it('builds query strings without empty values', () => {
    expect(withQuery('/audit', { actor: 'anna', action: '', cursor: 10, path: null })).toBe(
      '/audit?actor=anna&cursor=10',
    );
    expect(withQuery('/users')).toBe('/users');
  });

  it('sends JSON with the CSRF token and reports errors with their code', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(200, { ok: true }));
    const api = createApi('csrf-9', fetchFn);
    expect(await api.send('PATCH', '/pages', { path: '/x' })).toEqual({ ok: true });
    const [path, init] = fetchFn.mock.calls[0]!;
    expect(path).toBe('/_cms/api/pages');
    expect(init?.method).toBe('PATCH');
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('csrf-9');
    expect(JSON.parse(init?.body as string)).toEqual({ path: '/x' });

    fetchFn.mockResolvedValueOnce(
      jsonResponse(409, { error: { code: 'conflict', message: 'Conflitto' } }),
    );
    await expect(api.get('/pages', { path: '/x' })).rejects.toEqual(
      new ApiError(409, 'Conflitto', 'conflict'),
    );
    expect(fetchFn.mock.calls[1]![0]).toBe('/_cms/api/pages?path=%2Fx');
  });
});
