import { describe, expect, it } from 'vitest';
import type { Block } from './blocks.ts';
import { parseLayout, parseMenu, parsePageBody, parseSiteSettings } from './documents.ts';
import { BLOCK_ID_PATTERN, newBlockId } from './ids.ts';

const p = (id: string, text: string): Block => ({ id, type: 'paragraph', content: [{ text }] });

function section(depth: number): Block {
  let block: Block = p('leaf', 'x');
  for (let i = depth; i > 0; i--)
    block = { id: `s${i}`, type: 'section', tag: 'section', children: [block] };
  return block;
}

const fullBody = {
  meta: {
    title: 'Chi siamo',
    description: 'Una pagina di prova',
    lang: 'it',
    canonical: '/chi-siamo',
    robots: 'index, follow',
    og: { title: 'Chi siamo', image: 'asset_123' },
    jsonLd: { '@context': 'https://schema.org', '@type': 'Organization' },
  },
  blocks: [
    { id: 'h1', type: 'heading', level: 1, text: 'Chi siamo' },
    {
      id: 'p1',
      type: 'paragraph',
      content: [
        { text: 'Scrivici a ' },
        { text: 'info@example.com', href: 'mailto:info@example.com', bold: true },
      ],
    },
    {
      id: 'img',
      type: 'image',
      src: 'https://cdn.example.com/a.jpg',
      alt: 'Il team',
      width: 800,
      height: 600,
    },
    { id: 'deco', type: 'image', src: '/img/bg.png', alt: '', decorative: true },
    { id: 'g', type: 'gallery', images: [{ src: 'abc', alt: 'Uno' }] },
    {
      id: 'l',
      type: 'list',
      ordered: true,
      items: [[{ text: 'uno' }], [{ text: 'due', italic: true }]],
    },
    { id: 'q', type: 'quote', content: [{ text: 'Citazione' }], cite: 'Qualcuno' },
    { id: 'b', type: 'button', label: 'Contatti', href: '/contatti', variant: 'primary' },
    {
      id: 'sec',
      type: 'section',
      tag: 'article',
      label: 'Storia',
      children: [{ id: 'h2', type: 'heading', level: 2, text: 'La storia' }],
    },
    { id: 'raw', type: 'html', html: '<p>ciao</p>' },
  ],
};

describe('page body', () => {
  it('accepts the seeded blank page', () => {
    expect(parsePageBody({ meta: {}, blocks: [] })).toEqual({
      ok: true,
      value: { meta: {}, blocks: [] },
    });
  });

  it('accepts every block type', () => {
    const result = parsePageBody(fullBody);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.blocks).toHaveLength(10);
  });

  it('reports readable Italian errors with paths', () => {
    const result = parsePageBody({
      meta: { robots: 'boh' },
      blocks: [
        { id: 'a', type: 'heading', level: 7, text: 'x' },
        { id: 'b', type: 'paragraph', content: [{ text: 'x', href: 'javascript:alert(1)' }] },
        { id: 'c', type: 'image', src: 'x', alt: '' },
        { id: 'd', type: 'video' },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const byPath = Object.fromEntries(result.errors.map((e) => [e.path, e.message]));
    expect(byPath['meta.robots']).toMatch(/robots/);
    expect(byPath['blocks[0].level']).toMatch(/tra 1 e 6/);
    expect(byPath['blocks[1].content[0].href']).toMatch(/Link non valido/);
    expect(byPath['blocks[2].alt']).toMatch(/testo alternativo/);
    expect(byPath['blocks[3].type']).toMatch(/Tipo di blocco sconosciuto/);
  });

  it('rejects unknown keys and a missing meta', () => {
    expect(parsePageBody({ blocks: [] }).ok).toBe(false);
    expect(parsePageBody({ meta: {}, blocks: [], extra: 1 }).ok).toBe(false);
    expect(parsePageBody({ meta: {}, blocks: [{ ...p('a', 'x'), foo: 1 }] }).ok).toBe(false);
  });

  it('rejects unsafe or odd links', () => {
    for (const href of [
      '//evil.com',
      'data:text/html,x',
      'ftp://x',
      'java\tscript:x',
      'relative',
      'https://',
    ]) {
      const r = parsePageBody({
        meta: {},
        blocks: [{ id: 'b', type: 'button', label: 'x', href }],
      });
      expect(r.ok, href).toBe(false);
    }
    for (const href of [
      'https://example.com/a?b#c',
      'http://x.it',
      'mailto:a@b.it',
      'tel:+39061234',
      '/a/b',
    ]) {
      const r = parsePageBody({
        meta: {},
        blocks: [{ id: 'b', type: 'button', label: 'x', href }],
      });
      expect(r.ok, href).toBe(true);
    }
  });

  it('limits section depth', () => {
    expect(parsePageBody({ meta: {}, blocks: [section(6)] }).ok).toBe(true);
    const deep = parsePageBody({ meta: {}, blocks: [section(7)] });
    expect(deep.ok).toBe(false);
    if (!deep.ok) expect(deep.errors[0]!.message).toMatch(/annidate/);
    // Very deep input is rejected without walking it recursively.
    expect(parsePageBody({ meta: {}, blocks: [section(50_000)] }).ok).toBe(false);
  });

  it('rejects duplicate block ids, even across sections', () => {
    const r = parsePageBody({
      meta: {},
      blocks: [p('a', 'x'), { id: 's', type: 'section', tag: 'div', children: [p('a', 'y')] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/"a"/);
  });

  it('rejects oversized input', () => {
    const blocks = Array.from({ length: 501 }, (_, i) => p(`b${i}`, 'x'));
    expect(parsePageBody({ meta: {}, blocks }).ok).toBe(false);
    expect(
      parsePageBody({
        meta: {},
        blocks: [{ id: 'h', type: 'heading', level: 1, text: 'x'.repeat(301) }],
      }).ok,
    ).toBe(false);
  });
});

describe('site settings', () => {
  it('accepts the seeded settings', () => {
    const value = { name: 'Il mio sito', lang: 'it', titleTemplate: '%s · Il mio sito' };
    expect(parseSiteSettings(value)).toEqual({ ok: true, value });
  });

  it('requires %s in the title template', () => {
    const r = parseSiteSettings({ name: 'x', lang: 'it', titleTemplate: 'Sito' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatchObject({ path: 'titleTemplate' });
  });
});

describe('layout and menu', () => {
  it('parses a layout', () => {
    expect(parseLayout({ blocks: [p('a', 'x')] }).ok).toBe(true);
  });

  it('parses nested menus up to three levels', () => {
    const item = (children?: unknown[]) => ({
      label: 'Voce',
      href: '/x',
      ...(children ? { children } : {}),
    });
    expect(parseMenu({ items: [item([item([item()])])] }).ok).toBe(true);
    expect(parseMenu({ items: [item([item([item([item()])])])] }).ok).toBe(false);
    expect(parseMenu({ items: [{ label: '', href: '/x' }] }).ok).toBe(false);
  });
});

describe('newBlockId', () => {
  it('generates distinct valid ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, newBlockId));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(BLOCK_ID_PATTERN);
  });
});
