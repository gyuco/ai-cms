import { createRequire } from 'node:module';
import type { renderToStaticMarkup as RenderToStaticMarkup } from 'react-dom/server';
import type { PageBody } from '@ai-cms/content';
import { Blocks } from './render/blocks.tsx';
import { PageView, type PageViewProps } from './render/page.tsx';

// Loaded at run time: Next.js rejects a static `react-dom/server` import anywhere in the
// graph of a route handler, even though this code never runs inside a Server Component.
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as {
  renderToStaticMarkup: typeof RenderToStaticMarkup;
};

export interface DocumentHead {
  lang: string;
  title: string;
  description?: string;
}

/**
 * Renders a content page as a complete static HTML document, without Next.js: used to
 * validate drafts against the HTML rules before they are saved or published (TECHNICAL §11).
 * The markup of `<body>` is the same the site renders. Not for use inside React Server
 * Components (Next.js forbids `react-dom/server` there): import `@ai-cms/site-kit/document`.
 */
export function renderPageDocument(head: DocumentHead, body: PageViewProps): string {
  const markup = renderToStaticMarkup(
    <html lang={head.lang}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{head.title}</title>
        {head.description ? <meta name="description" content={head.description} /> : null}
      </head>
      <body>
        <PageView {...body} />
      </body>
    </html>,
  );
  return `<!doctype html>${markup}`;
}

/**
 * The markup inside `<main>` of a page, as the site renders it, for the in-place preview of a
 * plan in the widget (E7.5): the widget swaps it into the live `<main>` and highlights the
 * blocks by `data-cms-block`. Same module and same restriction as `renderPageDocument`.
 */
export function renderMainMarkup(page: PageBody): string {
  return renderToStaticMarkup(<Blocks blocks={page.blocks} />);
}
