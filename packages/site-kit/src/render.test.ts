import { parseLayout, parsePageBody, type Layout, type PageBody } from '@ai-cms/content';
import { formatReport, validateDocument } from '@ai-cms/html-rules';
import { describe, expect, it } from 'vitest';
import { renderPageDocument } from './document.tsx';
import { pageOutline } from './render/page.tsx';

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

const fullPage = page({
  meta: {
    title: 'Prova',
    description: 'Una pagina di prova con un blocco di ogni tipo per verificare il renderer.',
    jsonLd: { '@context': 'https://schema.org', '@type': 'WebPage', name: '</script><b>x' },
  },
  blocks: [
    { id: 'h1', type: 'heading', level: 1, text: 'Titolo della pagina' },
    {
      id: 'p1',
      type: 'paragraph',
      content: [
        { text: 'Testo ' },
        { text: 'forte', bold: true },
        { text: ', corsivo', italic: true },
        { text: ', codice', code: true },
        { text: ', link interno', href: '/chi-siamo' },
        { text: ' e link esterno', href: 'https://example.com/', bold: true },
        { text: ' e posta', href: 'mailto:info@example.com' },
      ],
    },
    {
      id: 'img',
      type: 'image',
      src: '/foto.jpg',
      alt: 'Una foto',
      caption: 'Didascalia',
      width: 800,
      height: 600,
    },
    { id: 'deco', type: 'image', src: 'asset_123', alt: '', decorative: true },
    {
      id: 'gal',
      type: 'gallery',
      images: [
        { src: 'https://cdn.example.com/a.png', alt: 'A' },
        { src: '/b.png', alt: 'B', caption: 'Seconda' },
      ],
    },
    {
      id: 's1',
      type: 'section',
      tag: 'section',
      label: 'Servizi',
      children: [
        { id: 'h2', type: 'heading', level: 2, text: 'Servizi' },
        { id: 'ul', type: 'list', ordered: false, items: [[{ text: 'Uno' }], [{ text: 'Due' }]] },
        { id: 'ol', type: 'list', ordered: true, items: [[{ text: 'Primo', bold: true }]] },
        {
          id: 'd1',
          type: 'section',
          tag: 'div',
          label: 'Gruppo',
          children: [{ id: 'b1', type: 'button', label: 'Contattaci', href: '/contatti' }],
        },
      ],
    },
    {
      id: 'a1',
      type: 'section',
      tag: 'article',
      children: [
        { id: 'h2b', type: 'heading', level: 2, text: 'Articolo' },
        { id: 'q1', type: 'quote', content: [{ text: 'Una citazione.' }], cite: 'Qualcuno' },
        { id: 'q2', type: 'quote', content: [{ text: 'Senza fonte.' }] },
      ],
    },
    {
      id: 'aside',
      type: 'section',
      tag: 'aside',
      label: 'Nota',
      children: [
        {
          id: 'b2',
          type: 'button',
          label: 'Sito esterno',
          href: 'https://example.org',
          variant: 'secondary',
        },
      ],
    },
    { id: 'html', type: 'html', html: '<p>HTML <em>libero</em></p>' },
  ],
});

const header = layout({
  blocks: [{ id: 'hp', type: 'paragraph', content: [{ text: 'Home', href: '/' }] }],
});
const footer = layout({
  blocks: [{ id: 'fp', type: 'paragraph', content: [{ text: '© Nuovo sito' }] }],
});

describe('renderPageDocument', () => {
  it('renders the blank home page as a valid document with an empty <main>', async () => {
    const html = renderPageDocument(
      { lang: 'it', title: 'Nuovo sito' },
      { page: page({ meta: {}, blocks: [] }), nodePath: 'site.pages.index' },
    );
    expect(html).toContain('<main data-cms-node="/site/pages/index"></main>');
    expect(html).not.toContain('<header');
    const report = await validateDocument(html);
    expect(report.errors, formatReport(report)).toEqual([]);
  });

  it('renders every block type as valid, semantic HTML', async () => {
    const html = renderPageDocument(
      { lang: 'it', title: 'Prova · Nuovo sito', description: fullPage.meta.description },
      { page: fullPage, nodePath: 'site.pages.prova', header, footer, nonce: 'abc' },
    );
    const report = await validateDocument(html);
    expect(report.errors, formatReport(report)).toEqual([]);
    expect(report.warnings, formatReport(report)).toEqual([]);

    expect(html).toContain('<header data-cms-node="/site/layouts/header">');
    expect(html).toContain('<main data-cms-node="/site/pages/prova">');
    expect(html).toContain('<footer data-cms-node="/site/layouts/footer">');
    expect(html).toContain('<h1 data-cms-block="h1">Titolo della pagina</h1>');
    expect(html).toContain('<strong>forte</strong>');
    expect(html).toContain('<em>, corsivo</em>');
    expect(html).toContain('<code>, codice</code>');
    expect(html).toContain('<a href="/chi-siamo">, link interno</a>');
    expect(html).toContain(
      '<a href="https://example.com/" rel="noopener noreferrer"><strong> e link esterno</strong></a>',
    );
    expect(html).toContain('<a href="mailto:info@example.com"> e posta</a>');
    expect(html).toMatch(
      /<figure data-cms-block="img" class="cms-image"><img src="\/foto.jpg" alt="Una foto" width="800" height="600"/,
    );
    expect(html).toContain('<figcaption>Didascalia</figcaption>');
    expect(html).toContain('src="/_cms/assets/asset_123" alt=""');
    expect(html).toContain('<ul data-cms-block="gal" class="cms-gallery"><li><figure');
    expect(html).toContain('<section data-cms-block="s1" aria-label="Servizi">');
    expect(html).toContain('<div data-cms-block="d1" aria-label="Gruppo" role="group">');
    expect(html).toContain('<ol data-cms-block="ol"><li><strong>Primo</strong></li></ol>');
    expect(html).toContain('<figure data-cms-block="q1" class="cms-quote"><blockquote>');
    expect(html).toContain('<cite>Qualcuno</cite>');
    expect(html).toContain('<blockquote data-cms-block="q2"><p>Senza fonte.</p></blockquote>');
    expect(html).toContain(
      '<a data-cms-block="b1" class="cms-button cms-button--primary" href="/contatti">Contattaci</a>',
    );
    expect(html).toContain(
      'class="cms-button cms-button--secondary" href="https://example.org" rel="noopener noreferrer"',
    );
    expect(html).toContain(
      '<div data-cms-block="html" class="cms-html"><p>HTML <em>libero</em></p></div>',
    );
    expect(html).toContain('<script type="application/ld+json" nonce="abc">');
    expect(html).not.toContain('</script><b>');
  });

  it('treats links to the site origin as internal', async () => {
    const html = renderPageDocument(
      { lang: 'it', title: 'Link' },
      {
        page: page({
          meta: {},
          blocks: [
            { id: 'h', type: 'heading', level: 1, text: 'Link' },
            {
              id: 'p',
              type: 'paragraph',
              content: [{ text: 'qui', href: 'http://www.localhost/x' }],
            },
          ],
        }),
        nodePath: 'site.pages.link',
        options: { siteOrigin: 'http://www.localhost' },
      },
    );
    expect(html).toContain('<a href="http://www.localhost/x">qui</a>');
  });

  it('reports rule violations in the rendered page', async () => {
    const html = renderPageDocument(
      { lang: 'it', title: 'Errata' },
      {
        page: page({
          meta: {},
          blocks: [
            { id: 'a', type: 'heading', level: 1, text: 'Uno' },
            { id: 'b', type: 'heading', level: 1, text: 'Due' },
          ],
        }),
        nodePath: 'site.pages.errata',
      },
    );
    expect((await validateDocument(html)).ok).toBe(false);
  });
});

describe('pageOutline', () => {
  it('lists headings of header, page and footer in document order', async () => {
    const withHeading = layout({
      blocks: [{ id: 'fh', type: 'heading', level: 2, text: 'Contatti' }],
    });
    expect(pageOutline(fullPage, header, withHeading).map((e) => [e.level, e.text])).toEqual([
      [1, 'Titolo della pagina'],
      [2, 'Servizi'],
      [2, 'Articolo'],
      [2, 'Contatti'],
    ]);
  });
});
