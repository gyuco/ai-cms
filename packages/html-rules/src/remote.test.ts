import { describe, expect, it, vi } from 'vitest';
import { nextPage } from './fixtures/next-page.ts';
import { checkRenderedPage } from './remote.ts';

const html = (body: string, status = 200) =>
  vi.fn<typeof fetch>(async () => new Response(body, { status }));

describe('checkRenderedPage', () => {
  it('validates the page as the site renders it', async () => {
    const fetchFn = html(nextPage());
    const result = await checkRenderedPage('http://site-prod:3000/chi-siamo', { fetch: fetchFn });
    expect(fetchFn).toHaveBeenCalledWith('http://site-prod:3000/chi-siamo', expect.anything());
    expect(result).toMatchObject({ status: 'checked', report: { ok: true, errors: [] } });
  });

  it('reports the errors of a broken page', async () => {
    const result = await checkRenderedPage('http://site/x', {
      fetch: html('<!doctype html><html><head></head><body><h1>a</h1><h1>b</h1></body></html>'),
    });
    expect(result.status).toBe('checked');
    if (result.status !== 'checked') return;
    expect(result.report.ok).toBe(false);
    expect(result.report.errors.map((e) => e.rule)).toContain('ai-cms/single-h1');
  });

  it('returns a warning when the site cannot be reached or answers with an error', async () => {
    const down = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await checkRenderedPage('http://site/x', { fetch: down })).toMatchObject({
      status: 'unavailable',
      message: expect.stringContaining('non è raggiungibile'),
    });
    expect(await checkRenderedPage('http://site/x', { fetch: html('', 404) })).toMatchObject({
      status: 'unavailable',
      message: expect.stringContaining('404'),
    });
    expect(await checkRenderedPage('http://site/x', { fetch: html('', 502) })).toMatchObject({
      status: 'unavailable',
      message: expect.stringContaining('502'),
    });
  });
});
