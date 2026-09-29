/**
 * HTML rules on a page before it goes on the site (TECHNICAL §11, E6.7). The page is rendered
 * with the same `<head>` and `<body>` markup the site produces, from the *published* settings
 * and shared elements, because that is what the visitor will get: a draft checked against
 * another header would pass here and fail on the site.
 */
import {
  parseLayout,
  parsePageBody,
  type Layout,
  type PageBody,
  type SiteSettings,
} from '@ai-cms/content';
import { getSharedElements, type RenderValidator } from '@ai-cms/content/service';
import type { Principal } from '@ai-cms/authz';
import { schema, type Database } from '@ai-cms/db';
import type { Violation } from '@ai-cms/html-rules';
import { DEFAULT_SETTINGS, pageTitle } from '@ai-cms/site-kit';
import { checkPageRules } from '@ai-cms/site-kit/page-rules';
import { parsePath } from '@ai-cms/tree';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Env } from './http.ts';

const { nodes, contentVersions, publications } = schema;

/** Layout names of `/site/layouts`, as `getSharedElements` keys them. */
const HEADER = 'header';
const FOOTER = 'footer';
const MENU = 'main';

/** Only the pages of the site have a title that must be unique. */
const PAGES_LTREE = 'site.pages';

/**
 * The page a shared layout is checked inside: the layout is what the site wraps around it, so
 * the page carries no content of its own and the layout is the only thing under test.
 */
const BLANK_PAGE: PageBody = { meta: { title: 'Bottega' }, blocks: [] };

/** One line per blocking error, with where it is, as the user and the agent read it. */
export function violationLines(errors: readonly Violation[]): string[] {
  return errors.map((error) => {
    const where = error.line
      ? ` (riga ${String(error.line)}${error.selector ? `, ${error.selector}` : ''})`
      : '';
    return `${error.message}${where}`;
  });
}

/**
 * Titles of the other pages already published in `env`, as the site renders them through the
 * title template: the uniqueness rule compares the `<title>` the page is going to have.
 */
async function otherPublishedTitles(
  db: Database,
  env: Env,
  settings: SiteSettings,
  exceptPath: string,
): Promise<string[]> {
  // `parsePath` drops the leading slash the services use, which ltree does not accept.
  const ltreePath = parsePath(exceptPath);
  const rows = await db
    .selectDistinct({ title: sql<string | null>`${contentVersions.body} -> 'meta' ->> 'title'` })
    .from(publications)
    .innerJoin(contentVersions, eq(contentVersions.id, publications.versionId))
    .innerJoin(nodes, eq(nodes.id, publications.nodeId))
    .where(
      and(
        eq(publications.env, env),
        eq(publications.status, 'published'),
        isNull(nodes.deletedAt),
        sql`${nodes.path} <@ ${PAGES_LTREE}::ltree`,
        sql`${nodes.path} <> ${ltreePath}::ltree`,
      ),
    );
  return rows
    .filter((row): row is { title: string } => row.title !== null)
    .map((row) => pageTitle({ meta: { title: row.title } }, settings));
}

export interface PageCheck {
  /** Blocking errors: the page cannot go on the site. */
  errors: string[];
  /** Advisories: shown, never blocking (FR-168). */
  warnings: string[];
}

/** The body a node can hold, once parsed; the agent tools check all of them. */
type DocumentBody = { kind: 'page'; body: PageBody } | { kind: 'layout'; body: Layout };

/**
 * What the body is. A layout (`/site/layouts/header`) is checked as the part it becomes, that
 * is around a page; a page is checked as a page. Anything else has no HTML rules of its own.
 */
function parseDocument(path: string, body: unknown): DocumentBody | { error: string } {
  if (/\/site\/layouts\/[^/]+$/.test(path) || path === '/site/layouts/header') {
    const layout = parseLayout(body);
    return layout.ok ? { kind: 'layout', body: layout.value } : { error: 'layout non valido' };
  }
  const page = parsePageBody(body);
  return page.ok ? { kind: 'page', body: page.value } : { error: 'pagina non valida' };
}

/**
 * Renders a version as the site would and validates it. `path` is the public path of the node
 * (`/site/pages/chi-siamo`) and `body` the body of the version to check.
 */
export async function checkPageVersion(
  db: Database,
  principal: Principal,
  env: Env,
  path: string,
  body: unknown,
): Promise<PageCheck> {
  const shared = await getSharedElements(db, principal, env);
  // A site that has never published its settings renders with the defaults, like the template.
  const settings = shared.settings ?? DEFAULT_SETTINGS;
  const document = parseDocument(path, body);
  if ('error' in document) {
    // Bodies are normalized on save, so this means the content was corrupted: say so rather
    // than let it through. A menu has no HTML of its own: it is checked on the pages it links.
    return {
      errors: [`Il contenuto di ${path} non è valido e non può essere verificato.`],
      warnings: [],
    };
  }
  const report =
    document.kind === 'layout'
      ? // A shared layout is rendered around a page, so the check needs a page to sit in.
        await checkPageRules({
          page: BLANK_PAGE,
          nodePath: path,
          settings,
          header: document.body,
          otherTitles: [],
        })
      : await checkPageRules({
          page: document.body,
          nodePath: path,
          settings,
          header: shared.layouts[HEADER] ?? null,
          footer: shared.layouts[FOOTER] ?? null,
          menu: shared.menus[MENU] ?? null,
          otherTitles: await otherPublishedTitles(db, env, settings, path),
        });
  return { errors: violationLines(report.errors), warnings: violationLines(report.warnings) };
}

/**
 * The validator the publication services expect (`PublishOptions.validateRendered`): it renders
 * the draft and answers the blocking errors, which keep it out of the site (FR-168).
 */
export function renderValidator(db: Database, principal: Principal, env: Env): RenderValidator {
  return async (path, body) => {
    const { errors } = await checkPageVersion(db, principal, env, path, body);
    return { errors };
  };
}
