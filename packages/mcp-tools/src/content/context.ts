/**
 * What the content tools receive from cms-api, and the helpers they share (E9.1).
 *
 * The tools never touch the database or the storage directly: they call the services of
 * `@ai-cms/content` and `@ai-cms/tree`, which check the permissions (FR-132), and everything
 * they cannot build themselves — the connection, the storage, the HTML rules — arrives in the
 * context. That is what the `Extra` type of `CmsToolContext` is for (registry.ts).
 */
import type { PublishHook, RenderValidator } from '@ai-cms/content/service';
import type { AssetStorage } from '@ai-cms/content/assets';
import type { Executor } from '@ai-cms/tree';
import type { z } from 'zod';
import type { CmsTool, CmsToolContext } from '../registry.ts';

/** The result of checking a rendered page, as the agent reads it (E6.7). */
export interface PageCheck {
  /** Blocking errors: the page cannot go on the site. */
  errors: string[];
  /** Advisories: never blocking (FR-168). */
  warnings: string[];
}

/** The services the tools need but cannot build: only cms-api has them. */
export interface ContentServices {
  /** Connection as the `cms_api` role: DML only, and every call goes through authz. */
  db: Executor;
  /** Assets live in S3 (SeaweedFS locally); cms-api is the only service with the secrets. */
  storage: AssetStorage;
  /** Passed to `publish`, so the site regenerates the paths that changed. */
  onPublished: PublishHook;
  /**
   * Rules on the rendered page, as the publication services expect them: a version with these
   * errors never goes online.
   */
  validateRendered: RenderValidator;
  /** The same check with its warnings, for the tools that report what they just wrote. */
  checkPage: (path: string, body: unknown) => Promise<PageCheck>;
}

/** What the session adds to the services: which conversation, and which changeset (if any). */
export interface ContentSession {
  conversationId: string | null;
  changesetId: string | null;
}

export type ContentExtra = ContentServices & ContentSession;

export type ContentContext = CmsToolContext<ContentExtra>;

export type ContentTool<S extends z.ZodObject = z.ZodObject> = CmsTool<S, ContentExtra>;

/**
 * Every write records the conversation it belongs to, so a version can be opened again from
 * it (FR-65), and the agent profile that wrote it.
 */
export function saveOptions(
  ctx: ContentContext,
  expectedVersion?: number,
): { expectedVersion?: number; viaAgent: string | null; conversationId: string | null } {
  return {
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    viaAgent: ctx.principal.agent?.name ?? null,
    conversationId: ctx.conversationId,
  };
}

/** What a write tool answers with: what changed and what the HTML rules say about it. */
export interface WriteResult {
  path: string;
  version: number;
  /** Blocking errors on the rendered page; empty means the page can go online. */
  violations: string[];
  /** Advisories the agent may want to mention. */
  warnings: string[];
}

/**
 * The answer of a write tool on a page: it renders the version that was just saved and returns
 * the violations, so the agent never proposes HTML the site would refuse (TECHNICAL §11).
 */
export async function afterWrite(
  ctx: ContentContext,
  path: string,
  body: unknown,
  version: number,
): Promise<WriteResult> {
  const check = await ctx.checkPage(path, body);
  return { path, version, violations: check.errors, warnings: check.warnings };
}

/** The last part of a node path, which is the name of the node: `/site/pages/x` → `x`. */
export function nodeName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}
