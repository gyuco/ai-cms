import { type Layout, type Menu, type PageBody, type SiteSettings } from '@ai-cms/content';
import { validateDocument, type ValidationReport } from '@ai-cms/html-rules';
import { renderPageDocument, type DocumentHead } from './document.tsx';
import { pageLang, pageTitle } from './metadata.ts';
import type { RenderOptions } from './render/options.ts';

export interface PageRulesInput {
  /** Body of the version to check, already parsed. */
  page: PageBody;
  /** ltree path of the page node, e.g. `site.pages.chi-siamo`. */
  nodePath: string;
  /** Site settings of the environment: they give the language and the title template. */
  settings: SiteSettings;
  /** Shared header and footer, as the site renders them around `<main>`. */
  header?: Layout | null;
  footer?: Layout | null;
  /** Main menu, rendered in the header. */
  menu?: Menu | null;
  /** Titles of the other pages of the site, for the site-wide uniqueness rule. */
  otherTitles?: readonly string[];
  options?: RenderOptions;
}

/**
 * Renders a page version as the site would and validates it against the HTML rules
 * (TECHNICAL §11): the same `<head>` the site generates, the same `<body>` markup. The
 * agent tools use it to return the violations before proposing a plan, and publishing uses
 * it to refuse a version with blocking errors (FR-168).
 *
 * It renders the document only: paths that depend on the runtime (`canonical`, `og:url`,
 * absolute asset URLs) are not part of these rules.
 */
export async function checkPageRules(input: PageRulesInput): Promise<ValidationReport> {
  const head: DocumentHead = {
    lang: pageLang(input.page, input.settings),
    title: pageTitle(input.page, input.settings),
    ...(input.page.meta.description ? { description: input.page.meta.description } : {}),
  };
  const html = renderPageDocument(head, {
    page: input.page,
    nodePath: input.nodePath,
    header: input.header ?? null,
    footer: input.footer ?? null,
    menu: input.menu ?? null,
    options: input.options,
  });
  return validateDocument(html, { otherTitles: [...(input.otherTitles ?? [])] });
}
