export const DEFAULT_DESCRIPTION =
  'Studio di architettura a Cagliari: progetti residenziali, ristrutturazioni e consulenze.';

export const DEFAULT_BODY =
  '<header><a href="/"><img alt="Studio Rossi" loading="lazy" width="120" height="40" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_next/image?url=%2Flogo.png&amp;w=128&amp;q=75 1x, /_next/image?url=%2Flogo.png&amp;w=256&amp;q=75 2x" src="/_next/image?url=%2Flogo.png&amp;w=256&amp;q=75"/></a>' +
  '<nav aria-label="Menu principale"><ul><li><a href="/">Home</a></li><li><a href="/progetti">Progetti</a></li><li><a href="/contatti">Contatti</a></li></ul></nav></header>' +
  '<main><h1>Studio Rossi</h1><p>Progettiamo case dal 1998.</p>' +
  '<section><h2>Progetti</h2><article><header><h3>Casa sul mare</h3></header><p>Villa a Villasimius.</p><footer><a href="/progetti/casa-sul-mare">Leggi il progetto</a></footer></article></section>' +
  '<section><h2>Contatti</h2><form action="/contatti" method="post"><label for="_R_email_">Email</label><input id="_R_email_" type="email" name="email" autoComplete="email"/><button type="submit">Invia</button></form></section></main>' +
  '<footer><nav aria-label="Menu del piè di pagina"><a href="/privacy">Privacy</a></nav><p>© 2026 Studio Rossi</p></footer>';

export interface NextPageOptions {
  lang?: string;
  title?: string | null;
  description?: string | null;
  body?: string;
  head?: string;
}

/**
 * A page shaped like real Next.js App Router output: React-cased attributes (`charSet`,
 * `srcSet`, `fetchPriority`), self-closing void elements, boolean attributes with empty values,
 * preload links, async chunks without SRI, inline flight scripts with a CSP nonce, streaming
 * placeholders (`<!--$-->`, `<template>`, `hidden` divs) and ids like `_R_`.
 */
export function nextPage(options: NextPageOptions = {}): string {
  const {
    lang = 'it',
    title = 'Studio Rossi · Architettura',
    description = DEFAULT_DESCRIPTION,
    body = DEFAULT_BODY,
    head = '',
  } = options;
  const titleTag = title === null ? '' : `<title>${title}</title>`;
  const descriptionTag =
    description === null ? '' : `<meta name="description" content="${description}"/>`;
  return (
    `<!DOCTYPE html><html lang="${lang}"><head><meta charSet="utf-8"/>` +
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>' +
    '<link rel="stylesheet" href="/_next/static/chunks/0a1b2c3d4e5f6.css" data-precedence="next" nonce="bm9uY2U="/>' +
    '<link rel="preload" as="script" fetchPriority="low" href="/_next/static/chunks/1jkwicgwp7k1k.js" nonce="bm9uY2U="/>' +
    '<script src="/_next/static/chunks/0s6a1m5c8s0i-.js" async="" nonce="bm9uY2U="></script>' +
    '<script src="/_next/static/chunks/turbopack-33aa9y7d1wag1.js" async="" nonce="bm9uY2U="></script>' +
    '<link rel="expect" href="#_R_" blocking="render"/>' +
    titleTag +
    descriptionTag +
    '<link rel="canonical" href="https://studiorossi.example/"/>' +
    '<meta property="og:title" content="Studio Rossi"/><meta property="og:type" content="website"/>' +
    '<meta name="twitter:card" content="summary_large_image"/>' +
    '<link rel="icon" href="/favicon.ico?favicon.0b3bf435.ico" sizes="256x256" type="image/x-icon"/>' +
    '<script src="/_next/static/chunks/0cz1d0mv5g_q7.js" noModule="" nonce="bm9uY2U="></script>' +
    head +
    '</head><body><div hidden=""><!--$--><!--/$--></div>' +
    body +
    '<!--$?--><template id="B:0"></template><!--/$-->' +
    '<div hidden id="S:0"><p>Contenuto in streaming</p></div>' +
    '<script src="/_next/static/chunks/1jkwicgwp7k1k.js" id="_R_" async="" nonce="bm9uY2U="></script>' +
    '<script nonce="bm9uY2U=">(self.__next_f=self.__next_f||[]).push([0])</script>' +
    '<script nonce="bm9uY2U=">self.__next_f.push([1,"0:{\\"P\\":null,\\"b\\":\\"yv8QT8UYZ6E1WVSYGUZtT\\"}\\n"])</script>' +
    '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Studio Rossi"}</script>' +
    '</body></html>'
  );
}
