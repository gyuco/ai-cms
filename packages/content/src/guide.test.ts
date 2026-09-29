import { describe, expect, it } from 'vitest';
import {
  LAYOUT_BODY_EXAMPLE,
  MENU_BODY_EXAMPLE,
  PAGE_BODY_EXAMPLE,
  bodyShapeGuide,
  contentShapesGuide,
} from './guide.ts';
import { normalizeBodyForKind } from './kinds.ts';

describe('shape guide', () => {
  it.each([
    ['page', PAGE_BODY_EXAMPLE],
    ['layout', LAYOUT_BODY_EXAMPLE],
    ['menu', MENU_BODY_EXAMPLE],
  ])('the %s example is valid', (kind, example) => {
    const result = normalizeBodyForKind(kind, example);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('spells out the mistakes models make', () => {
    const page = bodyShapeGuide('page');
    expect(page).toContain('`blocks` è sempre un ARRAY');
    expect(page).toContain('`level` da 1 a 6');
    expect(page).toContain('`content` è un ARRAY di frammenti');
    expect(bodyShapeGuide('menu')).toContain('non ha blocchi');
  });

  it('covers page, layout and menu in the prompt guide', () => {
    const all = contentShapesGuide();
    expect(all).toContain('"items"');
    expect(all).toContain('"blocks"');
  });
});
