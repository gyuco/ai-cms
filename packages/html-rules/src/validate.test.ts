import { describe, expect, it } from 'vitest';
import { nextEmptyHome } from './fixtures/next-empty-home.ts';
import { DEFAULT_BODY, nextPage } from './fixtures/next-page.ts';
import { formatReport, validateDocument, type ValidationReport } from './validate.ts';

function rules(violations: { rule: string }[]): string[] {
  return violations.map((violation) => violation.rule);
}

function main(content: string): string {
  return nextPage({ body: `<main>${content}</main>` });
}

async function errorsOf(html: string): Promise<string[]> {
  return rules((await validateDocument(html)).errors);
}

async function warningsOf(html: string): Promise<string[]> {
  return rules((await validateDocument(html)).warnings);
}

describe('validateDocument: valid pages', () => {
  it('accepts the blank home rendered by the site template, without errors', async () => {
    const report = await validateDocument(nextEmptyHome);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    // The template has no description yet: that is only a warning.
    expect(rules(report.warnings)).toEqual(['ai-cms/meta-description']);
  });

  it('accepts a full Next.js page without errors or warnings', async () => {
    const report = await validateDocument(nextPage());
    expect(report).toEqual({ errors: [], warnings: [], ok: true });
  });

  it('accepts metadata streamed by Next.js into the hidden div at the top of <body>', async () => {
    const html = nextPage({ title: null, description: null }).replace(
      '<div hidden="">',
      `<div hidden=""><title>Titolo</title><meta name="description" content="${'x'.repeat(80)}"/>`,
    );
    expect(await validateDocument(html)).toEqual({ errors: [], warnings: [], ok: true });
    const visible = nextPage({ title: null }).replace('<main>', '<main><title>Titolo</title>');
    expect(await errorsOf(visible)).toEqual(['element-permitted-parent']);
  });

  it('accepts an empty <main> without <h1>', async () => {
    expect(await errorsOf(nextPage({ body: '<main></main>' }))).toEqual([]);
  });

  it('accepts hand-written HTML5', async () => {
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Hello</title>
    <meta name="description" content="A plain, hand-written HTML5 page used to check the validator.">
  </head>
  <body>
    <main>
      <h1>Hello</h1>
      <figure><img src="/a.png" alt=""><figcaption>Decorative</figcaption></figure>
      <h2>Section</h2>
      <h3>Subsection</h3>
      <h2>Another section</h2>
    </main>
  </body>
</html>`;
    expect(await validateDocument(html)).toEqual({ errors: [], warnings: [], ok: true });
  });

  it('reports line, column and selector', async () => {
    const html = nextPage({ body: '<main><h1>A</h1><img src="/a.png"></main>' });
    const [violation] = (await validateDocument(html)).errors;
    expect(violation).toMatchObject({
      rule: 'wcag/h37',
      line: 1,
      selector: 'html > body > main > img',
    });
    expect(violation?.column).toBeGreaterThan(1);
  });
});

describe('validateDocument: document errors', () => {
  it('requires the doctype', async () => {
    expect(await errorsOf(nextPage().replace('<!DOCTYPE html>', ''))).toEqual(['missing-doctype']);
  });

  it('requires an HTML5 doctype', async () => {
    const html = nextPage().replace(
      '<!DOCTYPE html>',
      '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">',
    );
    expect(await errorsOf(html)).toEqual(['doctype-html']);
  });

  it('requires <html lang>', async () => {
    expect(await errorsOf(nextPage().replace(' lang="it"', ''))).toEqual(['ai-cms/html-lang']);
    expect(await errorsOf(nextPage({ lang: ' ' }))).toEqual(['ai-cms/html-lang']);
  });

  it('requires a UTF-8 meta charset', async () => {
    expect(await errorsOf(nextPage().replace('<meta charSet="utf-8"/>', ''))).toEqual([
      'ai-cms/meta-charset',
    ]);
    expect(await errorsOf(nextPage().replace('charSet="utf-8"', 'charset="iso-8859-1"'))).toEqual([
      'ai-cms/meta-charset',
    ]);
  });

  it('requires the viewport', async () => {
    const html = nextPage().replace(
      '<meta name="viewport" content="width=device-width, initial-scale=1"/>',
      '',
    );
    expect(await errorsOf(html)).toEqual(['ai-cms/meta-viewport']);
  });
});

describe('validateDocument: title', () => {
  it('requires a <title>', async () => {
    const report = await validateDocument(nextPage({ title: null }));
    expect(rules(report.errors)).toEqual(['ai-cms/page-title']);
    expect(report.errors[0]?.message).toBe('Manca il <title> della pagina.');
  });

  it('rejects an empty <title>', async () => {
    expect(await errorsOf(nextPage({ title: '  ' }))).toEqual(['ai-cms/page-title']);
  });

  it('rejects two <title>', async () => {
    const html = nextPage({ head: '<title>Altro</title>' });
    expect(await errorsOf(html)).toEqual(['ai-cms/page-title']);
  });

  it('ignores <title> inside inline SVG', async () => {
    const html = main('<h1>A</h1><svg role="img" aria-label="Logo"><title>Logo</title></svg>');
    expect(await errorsOf(html)).toEqual([]);
  });

  it('requires the title to be unique in the site', async () => {
    const html = nextPage({ title: 'Chi siamo' });
    const report = await validateDocument(html, { otherTitles: ['Home', ' chi  SIAMO '] });
    expect(rules(report.errors)).toEqual(['ai-cms/page-title']);
    expect(report.errors[0]?.message).toContain('già usato da un’altra pagina');
    expect((await validateDocument(html, { otherTitles: ['Home'] })).ok).toBe(true);
  });

  it('warns when the title is longer than 60 characters', async () => {
    expect(await warningsOf(nextPage({ title: 'x'.repeat(60) }))).toEqual([]);
    expect(await warningsOf(nextPage({ title: 'x'.repeat(61) }))).toEqual(['ai-cms/title-length']);
  });
});

describe('validateDocument: meta description', () => {
  it('warns when it is missing', async () => {
    const report = await validateDocument(nextPage({ description: null }));
    expect(report.ok).toBe(true);
    expect(rules(report.warnings)).toEqual(['ai-cms/meta-description']);
  });

  it('warns when it is shorter than 50 or longer than 160 characters', async () => {
    expect(await warningsOf(nextPage({ description: 'x'.repeat(49) }))).toEqual([
      'ai-cms/meta-description',
    ]);
    expect(await warningsOf(nextPage({ description: 'x'.repeat(50) }))).toEqual([]);
    expect(await warningsOf(nextPage({ description: 'x'.repeat(160) }))).toEqual([]);
    expect(await warningsOf(nextPage({ description: 'x'.repeat(161) }))).toEqual([
      'ai-cms/meta-description',
    ]);
  });
});

describe('validateDocument: structure', () => {
  it('requires a <main>', async () => {
    expect(await errorsOf(nextPage({ body: '<div><h1>A</h1></div>' }))).toEqual([
      'ai-cms/single-main',
    ]);
  });

  it('rejects two <main>', async () => {
    const html = nextPage({ body: '<main><h1>A</h1></main><main><p>B</p></main>' });
    expect(await errorsOf(html)).toEqual(['ai-cms/single-main']);
  });

  it('allows a hidden second <main>', async () => {
    const html = nextPage({ body: '<main><h1>A</h1></main><main hidden><p>B</p></main>' });
    expect(await errorsOf(html)).toEqual([]);
  });

  it('requires an <h1> when <main> has content', async () => {
    expect(await errorsOf(main('<p>Testo</p>'))).toEqual(['ai-cms/single-h1']);
  });

  it('rejects two <h1>', async () => {
    expect(await errorsOf(main('<h1>A</h1><h1>B</h1>'))).toEqual(['ai-cms/single-h1']);
  });

  it('rejects skipped heading levels', async () => {
    const report = await validateDocument(main('<h1>A</h1><h2>B</h2><h4>C</h4>'));
    expect(rules(report.errors)).toEqual(['heading-level']);
    expect(report.errors[0]?.message).toContain('ci si aspetta <h3>, invece c’è <h4>');
  });

  it('rejects a first heading other than <h1>', async () => {
    const report = await validateDocument(main('<h2>B</h2><h1>A</h1>'));
    expect(rules(report.errors)).toEqual(['heading-level']);
  });

  it('rejects duplicate ids', async () => {
    const report = await validateDocument(main('<h1 id="a">A</h1><p id="a">B</p>'));
    expect(rules(report.errors)).toEqual(['no-dup-id']);
    expect(report.errors[0]?.message).toContain('"a"');
  });

  it('rejects invalid nesting', async () => {
    expect(await errorsOf(main('<h1>A</h1><ul><div>x</div></ul>'))).toEqual([
      'element-permitted-content',
    ]);
    expect(await errorsOf(main('<h1>A</h1><a href="/a"><a href="/b">b</a></a>'))).toContain(
      'element-permitted-content',
    );
    expect(await errorsOf(main('<h1>A</h1><li>x</li>'))).toEqual(['element-permitted-parent']);
  });

  it('rejects deprecated elements', async () => {
    const report = await validateDocument(main('<h1>A</h1><center>x</center>'));
    expect(rules(report.errors)).toEqual(['deprecated']);
    expect(report.errors[0]?.message).toContain('<center> è deprecato');
  });
});

describe('validateDocument: accessibility', () => {
  it('requires alt on images', async () => {
    expect(await errorsOf(main('<h1>A</h1><img src="/a.png">'))).toEqual(['wcag/h37']);
    expect(await errorsOf(main('<h1>A</h1><img src="/a.png" alt="">'))).toEqual([]);
  });

  it('requires link text', async () => {
    expect(await errorsOf(main('<h1>A</h1><a href="/x"></a>'))).toEqual(['wcag/h30']);
    expect(await errorsOf(main('<h1>A</h1><a href="/x"><img src="/i.png" alt=""></a>'))).toEqual([
      'wcag/h30',
    ]);
    expect(await errorsOf(main('<h1>A</h1><a href="/x" aria-label="Chiudi"></a>'))).toEqual([]);
  });

  it('requires button text', async () => {
    const report = await validateDocument(main('<h1>A</h1><button type="button"></button>'));
    expect(rules(report.errors)).toEqual(['text-content']);
    expect(report.errors[0]?.message).toContain('<button> senza testo accessibile');
    expect(
      await errorsOf(main('<h1>A</h1><button type="button" aria-label="Chiudi"></button>')),
    ).toEqual([]);
  });

  it('requires labels on form fields', async () => {
    expect(await errorsOf(main('<h1>A</h1><input type="text" name="q">'))).toEqual([
      'input-missing-label',
    ]);
    expect(await errorsOf(main('<h1>A</h1><select name="s"></select>'))).toEqual([
      'input-missing-label',
    ]);
    expect(
      await errorsOf(main('<h1>A</h1><label>Cerca <input type="text" name="q"></label>')),
    ).toEqual([]);
  });

  it('rejects references to missing ids', async () => {
    const html = main('<h1>A</h1><input type="text" aria-label="Cerca" aria-describedby="nope">');
    expect(await errorsOf(html)).toEqual(['no-missing-references']);
  });

  it('warns about buttons without type', async () => {
    const report = await validateDocument(main('<h1>A</h1><button>Invia</button>'));
    expect(report.ok).toBe(true);
    expect(rules(report.warnings)).toEqual(['no-implicit-button-type']);
  });
});

describe('validateDocument: landmarks', () => {
  it('warns about two page-level <header>', async () => {
    const html = nextPage({ body: `<header><p>Altro</p></header>${DEFAULT_BODY}` });
    const report = await validateDocument(html);
    expect(report.ok).toBe(true);
    expect(rules(report.warnings)).toEqual(['ai-cms/page-landmarks']);
  });

  it('warns about two page-level <footer>', async () => {
    const html = nextPage({ body: `${DEFAULT_BODY}<footer><p>Altro</p></footer>` });
    expect(await warningsOf(html)).toEqual(['ai-cms/page-landmarks']);
  });

  it('accepts header and footer inside articles and sections', async () => {
    const html = main(
      '<h1>A</h1><article><header><h2>B</h2></header><footer>c</footer></article>' +
        '<section><header><h2>C</h2></header></section>',
    );
    expect(await warningsOf(html)).toEqual([]);
  });

  it('warns about several <nav> without distinct labels', async () => {
    expect(
      await warningsOf(
        nextPage({ body: '<nav>a</nav><main></main><footer><nav>b</nav></footer>' }),
      ),
    ).toEqual(['ai-cms/page-landmarks']);
    expect(
      await warningsOf(
        nextPage({
          body: '<nav aria-label="Menu">a</nav><main></main><nav aria-label="menu">b</nav>',
        }),
      ),
    ).toEqual(['ai-cms/page-landmarks']);
  });
});

describe('formatReport', () => {
  it('summarises a clean report', () => {
    expect(formatReport({ errors: [], warnings: [], ok: true })).toBe(
      'Regole HTML: nessun problema.',
    );
  });

  it('lists errors and warnings with their location', async () => {
    const report = await validateDocument(
      nextPage({ description: null, body: '<main><p>Testo</p></main>' }),
    );
    expect(formatReport(report)).toBe(
      [
        'Regole HTML: 1 errore, 1 avviso. Gli errori bloccano la pubblicazione.',
        'Errori:',
        `- [ai-cms/single-h1] (riga 1:${String(report.errors[0]?.column)}, html > body > main) La pagina ha contenuto ma nessun <h1>: aggiungi un titolo principale che descriva la pagina.`,
        'Avvisi:',
        `- [ai-cms/meta-description] (riga 1:${String(report.warnings[0]?.column)}, html) Manca la meta description: aggiungi una descrizione della pagina di 50–160 caratteri.`,
      ].join('\n'),
    );
  });

  it('says when a page with warnings can be published', () => {
    const report: ValidationReport = {
      errors: [],
      warnings: [{ rule: 'ai-cms/title-length', message: 'Titolo lungo.' }],
      ok: true,
    };
    expect(formatReport(report)).toBe(
      [
        'Regole HTML: 0 errori, 1 avviso. La pagina è pubblicabile.',
        'Avvisi:',
        '- [ai-cms/title-length] Titolo lungo.',
      ].join('\n'),
    );
  });
});
