/**
 * Shared vocabulary of the changeset checks (TECHNICAL §8.2) and of the builder HTTP API.
 * Pure module with no database access: `apps/builder` and `apps/previews` import it through
 * `@ai-cms/pipeline/builder`.
 */

/** Every check, in the order of TECHNICAL §8.2 (`ai-review` is not part of the MVP). */
export const CHECK_NAMES = [
  'permissions',
  'typecheck',
  'lint',
  'deps',
  'unit',
  'migration',
  'build',
  'e2e',
  'html',
  'a11y',
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

/**
 * Checks run by the worker itself: they need no site code to run and use credentials that the
 * builder must never see (the migration role of the changeset database).
 */
export const WORKER_CHECKS = ['permissions', 'migration'] as const;

/** Checks run by the builder, the only service that executes site code. */
export const BUILDER_CHECKS = [
  'typecheck',
  'lint',
  'deps',
  'unit',
  'build',
  'e2e',
  'html',
  'a11y',
] as const;
export type BuilderCheckName = (typeof BUILDER_CHECKS)[number];

export const CHECK_STATUSES = ['queued', 'running', 'passed', 'failed', 'skipped'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export interface CheckResult {
  name: CheckName;
  status: CheckStatus;
  /** Italian text for people and for the developer agent; at most `MAX_CHECK_OUTPUT` bytes. */
  output: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

/** `POST /runs` body. */
export interface BuilderRunRequest {
  changesetId: string;
  /** Commit to check; it must exist in the changeset working clone. */
  commit: string;
  /** Changeset database (`app_cs_<id>`) with the `site_app` role: never a platform secret. */
  databaseUrl: string;
  checks: BuilderCheckName[];
  /** URL paths validated by the `html` check (home and pages touched by the changeset). */
  pages: string[];
  /** URL paths that must answer 200 in the `e2e` check (published pages). */
  publishedPages: string[];
}

export type BuilderRunStatus = 'queued' | 'running' | 'finished';

/** `GET /runs/:id` and `POST /runs` response. */
export interface BuilderRun {
  id: string;
  changesetId: string;
  commit: string;
  status: BuilderRunStatus;
  checks: CheckResult[];
  createdAt: string;
  finishedAt: string | null;
}

/**
 * `<artifactsRoot>/<changesetId>/preview.json`, written by the builder after a successful
 * build and read by the previews service: it always names the newest artifact.
 */
export interface PreviewConfig {
  changesetId: string;
  commit: string;
  /** Directory of the artifact, relative to `<artifactsRoot>/<changesetId>`. */
  artifact: string;
  /** Next.js standalone server, relative to the artifact directory. */
  server: string;
  /** Environment of the site process: only the changeset database, never platform secrets. */
  env: Record<string, string>;
  builtAt: string;
}

/** Environment variables a preview may receive from `preview.json`. */
export const PREVIEW_ENV_KEYS = ['DATABASE_URL', 'CMS_ENV'] as const;

export const MAX_CHECK_OUTPUT = 64 * 1024;

/**
 * Keeps check output under `max` bytes: the beginning (the command and the first errors) and
 * the end (the summary), with a marker in between.
 */
export function truncateOutput(text: string, max = MAX_CHECK_OUTPUT): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= max) return text;
  const head = Math.floor(max / 8);
  const tail = max - head - 200;
  const omitted = bytes.length - head - tail;
  return (
    bytes.subarray(0, head).toString('utf8') +
    `\n\n… [output troncato: ${String(omitted)} byte omessi] …\n\n` +
    bytes.subarray(bytes.length - tail).toString('utf8')
  );
}

export interface ChecksSummary {
  /** Every check finished and none failed: the changeset can become `ready`. */
  ok: boolean;
  failed: CheckName[];
  skipped: CheckName[];
  /** Still queued or running. */
  pending: CheckName[];
}

export function summarizeChecks(
  results: ReadonlyArray<Pick<CheckResult, 'name' | 'status'>>,
): ChecksSummary {
  const by = (status: CheckStatus[]) =>
    results.filter((r) => status.includes(r.status)).map((r) => r.name);
  const failed = by(['failed']);
  const pending = by(['queued', 'running']);
  return {
    ok: failed.length === 0 && pending.length === 0,
    failed,
    skipped: by(['skipped']),
    pending,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function isChangesetId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function isCommitId(value: unknown): value is string {
  return typeof value === 'string' && COMMIT.test(value);
}
