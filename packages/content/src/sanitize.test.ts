import { describe, expect, it } from 'vitest';
import { normalizeLayout, normalizePageBody } from './normalize.ts';
import { sanitizeHtml } from './sanitize.ts';

function expectClean(html: string) {
  const out = sanitizeHtml(html);
  expect(out).not.toMatch(/<script|<style|<iframe|<svg|<object|<embed/i);
  expect(out).not.toMatch(/\son\w+\s*=/i);
  expect(out).not.toMatch(/javascript:|vbscript:|data:|expression\(/i);
  expect(out).not.toMatch(/\sstyle\s*=/i);
  return out;
}

describe('sanitizeHtml', () => {
  it('keeps ordinary content markup', () => {
    const html =
      '<h2 id="intro">Titolo</h2><p class="lead">Testo <strong>forte</strong> e <em>enfasi</em>, ' +
      '<a href="/contatti">contatti</a>.</p><ul><li>uno</li></ul>' +
      '<figure><img src="https://cdn.example.com/a.jpg" alt="Foto" width="10" height="10" /><figcaption>Foto</figcaption></figure>' +
      '<table><caption>Dati</caption><thead><tr><th scope="col">A</th></tr></thead><tbody><tr><td colspan="2">1</td></tr></tbody></table>' +
      '<blockquote cite="https://example.com">Citazione</blockquote><pre><code>x &lt; y</code></pre>';
    expect(sanitizeHtml(html)).toBe(html);
  });

  it.each([
    ['script tag', '<p>ok</p><script>alert(1)</script>', '<p>ok</p>'],
    ['uppercase script', '<SCRIPT SRC="https://evil.example/x.js"></SCRIPT>', ''],
    ['img onerror', '<img src="x.png" onerror="alert(1)" alt="a">', '<img src="x.png" alt="a" />'],
    ['javascript: href', '<a href="javascript:alert(1)">x</a>', '<a>x</a>'],
    ['entity-encoded javascript:', '<a href="jav&#x09;ascript:alert(1)">x</a>', '<a>x</a>'],
    ['mixed-case javascript:', '<a href=" JaVaScRiPt:alert(1)">x</a>', '<a>x</a>'],
    ['svg onload', '<svg onload="alert(1)"><circle r="1"></circle></svg>', ''],
    ['data: href', '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>', '<a>x</a>'],
    [
      'data: img',
      '<img src="data:image/svg+xml,<svg onload=alert(1)>" alt="a">',
      '<img alt="a" />',
    ],
    ['style expression', '<p style="width: expression(alert(1))">x</p>', '<p>x</p>'],
    ['style tag', '<style>body{background:url(javascript:alert(1))}</style><p>x</p>', '<p>x</p>'],
    ['iframe', '<iframe src="https://evil.example"></iframe><p>x</p>', '<p>x</p>'],
    ['object/embed', '<object data="x.swf"></object><embed src="x.swf">', ''],
    ['form', '<form action="https://evil.example"><input name="p"></form>', ''],
    ['protocol-relative', '<a href="//evil.example">x</a>', '<a>x</a>'],
    ['vbscript', '<a href="vbscript:msgbox(1)">x</a>', '<a>x</a>'],
    ['event on div', '<div onclick="alert(1)" onmouseover="x()">x</div>', '<div>x</div>'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">', ''],
    ['base tag', '<base href="https://evil.example/">', ''],
    ['nested breakout', '<scr<script>ipt>alert(1)</script>', 'ipt&gt;alert(1)'],
  ])('neutralizes %s', (_, input, expected) => {
    expect(expectClean(input)).toBe(expected);
  });

  it('allows safe link schemes', () => {
    for (const href of [
      'https://example.com',
      'http://x.it',
      'mailto:a@b.it',
      'tel:+3906',
      '/a',
      '#top',
    ]) {
      expect(sanitizeHtml(`<a href="${href}">x</a>`)).toBe(`<a href="${href}">x</a>`);
    }
  });

  it('forces rel on target=_blank and drops other targets', () => {
    expect(sanitizeHtml('<a href="https://x.it" target="_blank" rel="opener">x</a>')).toBe(
      '<a href="https://x.it" rel="noopener noreferrer" target="_blank">x</a>',
    );
    expect(sanitizeHtml('<a href="https://x.it" target="_top">x</a>')).toBe(
      '<a href="https://x.it">x</a>',
    );
  });
});

describe('normalizePageBody', () => {
  it('sanitizes html blocks, nested ones included', () => {
    const result = normalizePageBody({
      meta: {},
      blocks: [
        { id: 'a', type: 'html', html: '<p><font color="red">a</font></p>' },
        {
          id: 's',
          type: 'section',
          tag: 'div',
          children: [{ id: 'b', type: 'html', html: '<a href="/x" target="_blank">b</a>' }],
        },
      ],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        meta: {},
        blocks: [
          { id: 'a', type: 'html', html: '<p>a</p>' },
          {
            id: 's',
            type: 'section',
            tag: 'div',
            children: [
              {
                id: 'b',
                type: 'html',
                html: '<a href="/x" target="_blank" rel="noopener noreferrer">b</a>',
              },
            ],
          },
        ],
      },
    });
  });

  it.each([
    ['un tag <style>', '<style>.h { color: red }</style>'],
    ['un attributo style', '<p style="color:red">a</p>'],
    ['un tag <script>', '<p>a</p><script>x()</script>'],
    ['un gestore di eventi (on*)', '<img src="x.png" onerror="alert(1)" alt="a">'],
  ])('rejects an html block with %s instead of silently dropping it', (what, html) => {
    const nested = {
      id: 's',
      type: 'section',
      tag: 'div',
      children: [{ id: 'css', type: 'html', html }],
    };
    for (const result of [
      normalizePageBody({ meta: {}, blocks: [nested] }),
      normalizeLayout({ blocks: [nested] }),
    ]) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.path).toBe('blocco "css"');
      expect(result.errors[0]?.message).toContain(what);
      expect(result.errors[0]?.message).toContain('Il CSS non va nei blocchi HTML');
      expect(result.errors[0]?.message).toContain('agente sviluppatore');
    }
  });

  it('rejects a block the sanitizer would empty, but accepts a genuinely empty one', () => {
    const emptied = normalizePageBody({
      meta: {},
      blocks: [{ id: 'x', type: 'html', html: '<template><p>a</p></template>' }],
    });
    expect(emptied.ok).toBe(false);
    if (!emptied.ok) expect(emptied.errors[0]?.message).toContain('tutto il contenuto');
    expect(normalizePageBody({ meta: {}, blocks: [{ id: 'x', type: 'html', html: '' }] }).ok).toBe(
      true,
    );
  });

  it('returns parse errors unchanged', () => {
    expect(normalizePageBody({ meta: {} }).ok).toBe(false);
  });

  it('sanitizes layouts too', () => {
    const result = normalizeLayout({
      blocks: [{ id: 'f', type: 'html', html: '<a href="javascript:x">f</a>' }],
    });
    expect(result).toEqual({
      ok: true,
      value: { blocks: [{ id: 'f', type: 'html', html: '<a>f</a>' }] },
    });
  });
});
