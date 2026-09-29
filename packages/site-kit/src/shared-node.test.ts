import { describe, expect, it } from 'vitest';
import type { DraftRequest, DraftResult } from './preview.ts';
import { sharedNodeBody } from './shared-node.ts';

const published = { body: { blocks: [{ id: 'p', type: 'paragraph' }] } };
const draftBody = { blocks: [{ id: 'd', type: 'paragraph' }] };

function sources(draft: DraftResult, session: string | undefined) {
  const requests: DraftRequest[] = [];
  const errors: string[] = [];
  return {
    requests,
    errors,
    value: {
      env: 'staging' as const,
      session,
      published: async () => published,
      draft: async (request: DraftRequest) => {
        requests.push(request);
        return draft;
      },
      onError: (message: string) => errors.push(message),
    },
  };
}

describe('sharedNodeBody', () => {
  it('never asks for drafts of an anonymous visitor', async () => {
    const s = sources({ status: 'ok', body: draftBody, version: 2, published: false }, undefined);
    expect(await sharedNodeBody('site.layouts.header', s.value)).toBe(published.body);
    expect(s.requests).toEqual([]);
  });

  it('shows the unpublished header to a signed-in user', async () => {
    const s = sources({ status: 'ok', body: draftBody, version: 2, published: false }, 'tok');
    expect(await sharedNodeBody('site.layouts.header', s.value)).toBe(draftBody);
    expect(s.requests).toEqual([
      { nodePath: 'site.layouts.header', env: 'staging', sessionToken: 'tok' },
    ]);
  });

  it.each<DraftResult>([{ status: 'denied' }, { status: 'not-found' }])(
    'falls back to the published one on %j',
    async (draft) => {
      const s = sources(draft, 'tok');
      expect(await sharedNodeBody('site.settings', s.value)).toBe(published.body);
      expect(s.errors).toEqual([]);
    },
  );

  it('falls back to the published one and reports when cms-api fails', async () => {
    const s = sources({ status: 'error', message: 'HTTP 500' }, 'tok');
    expect(await sharedNodeBody('site.menus.main', s.value)).toBe(published.body);
    expect(s.errors[0]).toContain('site.menus.main');
  });

  it('is null when nothing exists', async () => {
    const s = sources({ status: 'not-found' }, 'tok');
    expect(
      await sharedNodeBody('site.layouts.footer', { ...s.value, published: async () => null }),
    ).toBeNull();
  });
});
