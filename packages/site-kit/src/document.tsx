import { renderToStaticMarkup } from 'react-dom/server';
import { PageView, type PageViewProps } from './render/page.tsx';

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
