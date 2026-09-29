import { schema, type Database } from '@ai-cms/db';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  CHECK_NAMES,
  isChangesetId,
  type CheckName,
  type CheckResult,
} from './builder-protocol.ts';
import { ChangesetError, type Changeset } from './changesets.ts';

/** Correction rounds the developer agent gets after failed checks (FR-42). */
export const DEFAULT_AUTOFIX_ATTEMPTS = 3;

/** Job that asks the developer agent to fix the failed checks of a changeset. */
export const AUTOFIX_JOB = 'changeset.autofix';

/** Queue key: at most one correction round queued or running per changeset. */
export function autofixDedupeKey(changesetId: string): string {
  return `autofix:${changesetId}`;
}

/** `AUTOFIX_MAX_ATTEMPTS` (0 turns the correction off), or the default. */
export function maxAutofixAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AUTOFIX_MAX_ATTEMPTS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_AUTOFIX_ATTEMPTS;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= 10 ? value : DEFAULT_AUTOFIX_ATTEMPTS;
}

export interface FailedCheck {
  name: CheckName;
  output: string | null;
}

/** The message the agent receives with the errors to fix (Italian, like the check outputs). */
export function buildAutofixPrompt(input: {
  title: string;
  attempt: number;
  maxAttempts: number;
  failed: readonly FailedCheck[];
}): string {
  const lines = [
    `I controlli automatici del changeset "${input.title}" sono falliti (tentativo di correzione ${String(input.attempt)} di ${String(input.maxAttempts)}).`,
    'Correggi il codice in modo che tutti i controlli passino, senza indebolire test, regole di lint o controlli di sicurezza.',
    'Modifica solo ciò che serve. Al termine i controlli verranno rieseguiti in automatico.',
    '',
    'Controlli falliti:',
  ];
  for (const check of input.failed) {
    lines.push('', `### ${check.name}`, '```', (check.output ?? '(nessun output)').trim(), '```');
  }
  if (input.attempt >= input.maxAttempts) {
    lines.push(
      '',
      "Questo è l'ultimo tentativo automatico: poi servirà l'intervento di una persona.",
    );
  }
  return lines.join('\n');
}

export type AutofixPlan =
  | { action: 'retry'; attempt: number; maxAttempts: number; failed: FailedCheck[] }
  | { action: 'exhausted'; attempts: number; maxAttempts: number }
  | { action: 'none'; reason: string };

/** The checks of the latest recorded commit of a changeset, in the order of TECHNICAL §8.2. */
export async function latestCheckResults(
  db: Database,
  changeset: Pick<Changeset, 'id' | 'headCommit'>,
): Promise<CheckResult[]> {
  if (!changeset.headCommit) return [];
  const rows = await db
    .select()
    .from(schema.checkRuns)
    .where(
      and(
        eq(schema.checkRuns.changesetId, changeset.id),
        eq(schema.checkRuns.commit, changeset.headCommit),
      ),
    )
    .orderBy(desc(schema.checkRuns.id));
  const byName = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!byName.has(row.checkName)) byName.set(row.checkName, row);
  return CHECK_NAMES.flatMap((name) => {
    const row = byName.get(name);
    if (!row) return [];
    return [
      {
        name,
        status: row.status,
        output: row.output,
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
      },
    ];
  });
}

/**
 * Decides whether the agent gets another correction round and, if so, consumes one attempt.
 * The counter moves in a single conditional UPDATE, so two workers can never hand out more
 * than `maxAttempts` rounds for the same changeset.
 */
export async function planAutofix(
  db: Database,
  changesetId: string,
  maxAttempts: number = maxAutofixAttempts(),
): Promise<AutofixPlan> {
  if (!isChangesetId(changesetId)) {
    throw new ChangesetError(`Id di changeset non valido: ${changesetId}`);
  }
  const [taken] = await db
    .update(schema.changesets)
    .set({
      autofixAttempts: sql`${schema.changesets.autofixAttempts} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.changesets.id, changesetId),
        eq(schema.changesets.status, 'checks_failed'),
        lt(schema.changesets.autofixAttempts, maxAttempts),
      ),
    )
    .returning();
  if (taken) {
    const failed = (await latestCheckResults(db, taken))
      .filter((check) => check.status === 'failed')
      .map((check) => ({ name: check.name, output: check.output }));
    return { action: 'retry', attempt: taken.autofixAttempts, maxAttempts, failed };
  }
  const [changeset] = await db
    .select()
    .from(schema.changesets)
    .where(eq(schema.changesets.id, changesetId));
  if (!changeset) throw new ChangesetError(`Changeset ${changesetId} non trovato`);
  if (changeset.status !== 'checks_failed') {
    return { action: 'none', reason: `stato "${changeset.status}"` };
  }
  return { action: 'exhausted', attempts: changeset.autofixAttempts, maxAttempts };
}

export type AutofixState = 'idle' | 'running' | 'exhausted';

/** What the Development tab shows for a changeset: checks in progress and correction rounds. */
export interface ChangesetChecksState {
  changesetId: string;
  status: Changeset['status'];
  commit: string | null;
  checks: CheckResult[];
  autofix: { state: AutofixState; attempts: number; maxAttempts: number };
}

/** Read on every poll of the tab: the check rows are updated as the results arrive. */
export async function getChangesetChecksState(
  db: Database,
  changesetId: string,
  maxAttempts: number = maxAutofixAttempts(),
): Promise<ChangesetChecksState> {
  if (!isChangesetId(changesetId)) {
    throw new ChangesetError(`Id di changeset non valido: ${changesetId}`);
  }
  const [changeset] = await db
    .select()
    .from(schema.changesets)
    .where(eq(schema.changesets.id, changesetId));
  if (!changeset) throw new ChangesetError(`Changeset ${changesetId} non trovato`);
  const active = await db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.dedupeKey, autofixDedupeKey(changesetId)),
        inArray(schema.jobs.status, ['queued', 'running']),
      ),
    )
    .limit(1);
  let state: AutofixState = 'idle';
  if (active.length > 0) state = 'running';
  else if (changeset.status === 'checks_failed' && changeset.autofixAttempts >= maxAttempts) {
    state = maxAttempts > 0 ? 'exhausted' : 'idle';
  }
  return {
    changesetId,
    status: changeset.status,
    commit: changeset.headCommit,
    checks: await latestCheckResults(db, changeset),
    autofix: { state, attempts: changeset.autofixAttempts, maxAttempts },
  };
}
