import { describe, expect, it } from 'vitest';
import { parsePackageNames, workableChangesets, type ChangesetItem } from './dev.ts';

const item = (id: string, status: string, conversationId: string | null): ChangesetItem => ({
  id,
  title: id,
  status,
  conversationId,
  previewUrl: `http://cs-${id}.localhost`,
});

describe('workableChangesets', () => {
  it('keeps the changesets the agent can still change, opened from a chat', () => {
    const all = [
      item('a', 'draft', 'c1'),
      item('b', 'checks_failed', 'c2'),
      item('c', 'ready', 'c3'),
      item('d', 'releasing', 'c4'),
      item('e', 'draft', null),
    ];
    expect(workableChangesets(all).map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('parsePackageNames', () => {
  it('splits on spaces, commas and lines, without repeats', () => {
    expect(parsePackageNames('left-pad, @scope/x\nleft-pad  zod;')).toEqual([
      'left-pad',
      '@scope/x',
      'zod',
    ]);
    expect(parsePackageNames('   ')).toEqual([]);
  });
});
