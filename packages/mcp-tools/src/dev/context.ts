/**
 * What the developer-agent tools receive from cms-api (E10.6). Like the content tools, they
 * never touch the database or the queue: cms-api builds `DevServices` from the pipeline and
 * hands them in the context.
 */
import { requireAuthorized, type Action, type NodeTarget } from '@ai-cms/authz';
import type { z } from 'zod';
import type { CmsTool, CmsToolContext } from '../registry.ts';

export type DevCheckStatus = 'queued' | 'running' | 'passed' | 'failed' | 'skipped';

export interface DevCheckResult {
  name: string;
  status: DevCheckStatus;
  output: string | null;
}

/** The checks of the changeset's latest commit (TECHNICAL §8.2), as the agent reads them. */
export interface DevChecksState {
  changesetStatus: string;
  commit: string | null;
  checks: DevCheckResult[];
  ok: boolean;
  failed: string[];
  pending: string[];
}

export interface DevQueryResult {
  columns: string[];
  rows: unknown[][];
  /** True when more rows matched than the limit the service returns. */
  truncated: boolean;
}

export interface DevServices {
  /** Queues the `changeset.check` job; false when a run is already queued or running. */
  runChecks(changesetId: string): Promise<{ queued: boolean }>;
  getCheckResults(changesetId: string): Promise<DevChecksState>;
  /** Runs one read-only statement on the database of the changeset. */
  queryStagingDb(changesetId: string, statement: string): Promise<DevQueryResult>;
  /** Address of the changeset preview; `ready` once a build has produced it. */
  previewUrl(changesetId: string): Promise<{ url: string; ready: boolean }>;
}

export interface DevExtra {
  dev: DevServices;
  /** The changeset the agent works on; null outside a developer-agent session. */
  changesetId: string | null;
}

export type DevContext = CmsToolContext<DevExtra>;

export type DevTool<S extends z.ZodObject = z.ZodObject> = CmsTool<S, DevExtra>;

/** Tree node standing for what a tool touches, for the authz check (TECHNICAL §6). */
const CODE: NodeTarget = { path: 'code', kind: 'folder', storage: 'git' };
const DATA: NodeTarget = { path: 'data', kind: 'folder', storage: 'db' };

/**
 * Every developer tool needs the developer-agent profile in staging with a changeset; the
 * profile, the invariants and the user's own permissions decide the rest through `authz`.
 * Returns the changeset id.
 */
export function requireDevSession(
  ctx: DevContext,
  action: Action,
  target: 'code' | 'data',
): string {
  requireAuthorized(ctx.principal, action, target === 'code' ? CODE : DATA, ctx.env);
  if (ctx.principal.agent?.name !== 'dev-agent' || ctx.env !== 'staging') {
    throw new Error("Questo strumento è dell'agente sviluppatore e funziona solo in staging.");
  }
  if (!ctx.changesetId) throw new Error('Nessun changeset associato a questa sessione.');
  return ctx.changesetId;
}
