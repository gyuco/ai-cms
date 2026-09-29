import {
  parseLayout,
  parsePageBody,
  type Layout,
  type PageBody,
  type SiteSettings,
} from '@ai-cms/content';
import { formatReport } from '@ai-cms/html-rules';
import { describe, expect, it } from 'vitest';
import { checkPageRules } from './page-rules.ts';

function page(input: unknown): PageBody {
  const result = parsePageBody(input);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

function layout(input: unknown): Layout {
  const result = parseLayout(input);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

const settings: SiteSettings = {
  name: 'Nuovo sito',
  lang: 'it',
  titleTemplate: '%s · Nuovo sito',
};

const header = layout({
  blocks: [{ id: 'hp', type: 'paragraph', content: [{ text: 'Home', href: '/' }] }],
});

const goodPage = page({
  meta: { title: 'Chi siamo', description: 'Chi siamo, dove siamo e come lavoriamo ogni giorno.' },
  blocks: [{ id: 'h1', type: 'heading', level: 1, text: 'Chi siamo' }],
});

describe('checkPageRules', () => {
  it('accepts a page that follows the rules, with the header and footer of the site', async () => {
    const report = await checkPageRules({
      page: goodPage,
      nodePath: 'site.pages.chi-siamo',
      settings,
      header,
    });
    expect(report.errors, formatReport(report)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('builds the head from the site settings: language, title template and description', async () => {
    const report = await checkPageRules({
      page: page({
        meta: {
          title: 'Contatti',
          description: 'Scrivici: rispondiamo entro due giorni lavorativi.',
        },
        blocks: [{ id: 'h1', type: 'heading', level: 1, text: 'Contatti' }],
      }),
      nodePath: 'site.pages.contatti',
      settings: { ...settings, lang: 'en', titleTemplate: '%s | Nuovo sito' },
    });
    expect(report.errors, formatReport(report)).toEqual([]);
  });

  it('reports blocking errors, e.g. two <h1> in the same page', async () => {
    const report = await checkPageRules({
      page: page({
        meta: { title: 'Due titoli' },
        blocks: [
          { id: 'a', type: 'heading', level: 1, text: 'Uno' },
          { id: 'b', type: 'heading', level: 1, text: 'Due' },
        ],
      }),
      nodePath: 'site.pages.due',
      settings,
    });
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.rule)).toContain('ai-cms/single-h1');
  });

  it('reports a title already used by another page of the site', async () => {
    const report = await checkPageRules({
      page: goodPage,
      nodePath: 'site.pages.chi-siamo',
      settings,
      otherTitles: ['Chi siamo · Nuovo sito', 'Prodotti · Nuovo sito'],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.rule)).toContain('ai-cms/page-title');
  });

  it('ignores the case when comparing titles with the other pages', async () => {
    const report = await checkPageRules({
      page: goodPage,
      nodePath: 'site.pages.chi-siamo',
      settings,
      otherTitles: ['chi siamo · nuovo sito'],
    });
    expect(report.errors.map((e) => e.rule)).toContain('ai-cms/page-title');
  });

  it('reports a violation inside the shared header, as the site renders it', async () => {
    const report = await checkPageRules({
      page: goodPage,
      nodePath: 'site.pages.chi-siamo',
      settings,
      header: layout({
        blocks: [
          { id: 'a', type: 'heading', level: 2, text: 'Uno' },
          { id: 'b', type: 'heading', level: 4, text: 'Due' },
        ],
      }),
    });
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.rule)).toContain('heading-level');
  });

  it('keeps warnings out of the blocking errors', async () => {
    // No description and a short title: warnings, never errors (FR-168).
    const report = await checkPageRules({
      page: page({
        meta: { title: 'X' },
        blocks: [{ id: 'h1', type: 'heading', level: 1, text: 'X' }],
      }),
      nodePath: 'site.pages.x',
      settings,
    });
    expect(report.ok).toBe(true);
    expect(report.warnings.map((w) => w.rule)).toContain('ai-cms/meta-description');
  });
});
