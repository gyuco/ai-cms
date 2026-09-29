import { describe, expect, it } from 'vitest';
import type { PagePreview, PlanOperation, PlanResult } from '@ai-cms/content/service';
import {
  createPlanSession,
  isDestructiveOperation,
  planIsDestructive,
  previewIsMassiveOverwrite,
  requiresConfirmation,
} from './plan.ts';

const createPage: PlanOperation = {
  op: 'createPage',
  parentPath: '/site/pages',
  name: 'chi-siamo',
  body: { meta: {}, blocks: [] },
};
const deleteOp: PlanOperation = { op: 'delete', path: '/site/pages/vecchia' };
const publishOp: PlanOperation = { op: 'publish', path: '/site/pages/chi-siamo' };

describe('createPlanSession', () => {
  it('accumulates operations in the order they were proposed', () => {
    const session = createPlanSession();
    expect(session.isEmpty()).toBe(true);
    session.propose(createPage);
    session.propose(publishOp);
    expect(session.operations()).toEqual([createPage, publishOp]);
    expect(session.isEmpty()).toBe(false);
  });

  it('clear discards the accumulated operations', () => {
    const session = createPlanSession();
    session.propose(createPage);
    session.clear();
    expect(session.operations()).toEqual([]);
    expect(session.isEmpty()).toBe(true);
  });

  it('operations() returns a snapshot: later proposals do not change it', () => {
    const session = createPlanSession();
    session.propose(createPage);
    const snapshot = session.operations();
    session.propose(publishOp);
    expect(snapshot).toEqual([createPage]);
  });
});

describe('isDestructiveOperation / planIsDestructive', () => {
  it('flags delete and nothing else', () => {
    expect(isDestructiveOperation(deleteOp)).toBe(true);
    expect(isDestructiveOperation(createPage)).toBe(false);
    expect(isDestructiveOperation(publishOp)).toBe(false);
  });

  it('a plan is destructive as soon as one operation is', () => {
    expect(planIsDestructive([createPage, publishOp])).toBe(false);
    expect(planIsDestructive([createPage, deleteOp])).toBe(true);
  });
});

const preview = (over: Partial<PagePreview>): PagePreview => ({
  path: '/site/pages/chi-siamo',
  kind: 'page',
  created: false,
  baseVersion: 3,
  body: { meta: {}, blocks: [] },
  diff: { changed: true, blocks: { added: [], removed: [], modified: [], moved: [] }, fields: [] },
  ...over,
});

describe('previewIsMassiveOverwrite', () => {
  it('is false for a newly created page', () => {
    const p = preview({
      created: true,
      diff: {
        changed: true,
        blocks: {
          added: [],
          removed: [{ id: 'a', type: 'paragraph', parentId: null, index: 0 }],
          modified: [],
          moved: [],
        },
        fields: [],
      },
      body: { meta: {}, blocks: [] },
    });
    expect(previewIsMassiveOverwrite(p)).toBe(false);
  });

  it('is false when nothing was removed', () => {
    expect(previewIsMassiveOverwrite(preview({}))).toBe(false);
  });

  it('is false when blocks remain after the change', () => {
    const p = preview({
      diff: {
        changed: true,
        blocks: {
          added: [],
          removed: [{ id: 'a', type: 'paragraph', parentId: null, index: 0 }],
          modified: [],
          moved: [],
        },
        fields: [],
      },
      body: { meta: {}, blocks: [{ id: 'b', type: 'paragraph', content: [] }] },
    });
    expect(previewIsMassiveOverwrite(p)).toBe(false);
  });

  it('is true when an existing page loses all its blocks', () => {
    const p = preview({
      diff: {
        changed: true,
        blocks: {
          added: [],
          removed: [{ id: 'a', type: 'paragraph', parentId: null, index: 0 }],
          modified: [],
          moved: [],
        },
        fields: [],
      },
      body: { meta: {}, blocks: [] },
    });
    expect(previewIsMassiveOverwrite(p)).toBe(true);
  });
});

describe('requiresConfirmation', () => {
  it('is true for a plan with a delete, even without a preview', () => {
    expect(requiresConfirmation([createPage, deleteOp])).toBe(true);
  });

  it('is false for a harmless plan with no preview', () => {
    expect(requiresConfirmation([createPage, publishOp])).toBe(false);
  });

  it('is true when the preview shows a massive overwrite, even without a delete op', () => {
    const result: PlanResult = {
      dryRun: true,
      touched: ['/site/pages/chi-siamo'],
      versions: [],
      published: [],
      unpublished: [],
      revalidate: [],
      preview: [
        preview({
          diff: {
            changed: true,
            blocks: {
              added: [],
              removed: [{ id: 'a', type: 'paragraph', parentId: null, index: 0 }],
              modified: [],
              moved: [],
            },
            fields: [],
          },
          body: { meta: {}, blocks: [] },
        }),
      ],
    };
    expect(
      requiresConfirmation([{ op: 'updateBody', path: '/site/pages/chi-siamo', body: {} }], result),
    ).toBe(true);
  });
});
