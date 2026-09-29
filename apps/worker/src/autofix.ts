import { DEFAULT_RUN_TIMEOUT_MS, streamAgentRun } from '@ai-cms/ai-config';
import { writeAudit } from '@ai-cms/audit';
import { schema, type Database } from '@ai-cms/db';
import {
  autofixDedupeKey,
  buildAutofixPrompt,
  enqueue,
  isChangesetId,
  maxAutofixAttempts,
  planAutofix,
  type JobHandler,
} from '@ai-cms/pipeline';
import { eq } from 'drizzle-orm';

export interface AutofixOptions {
  /** `AGENT_RUNNER_URL`, e.g. `http://agent-runner:8070`. */
  runnerUrl?: string;
  fetch?: typeof fetch;
  /** `native` uses the active AI connection; `claude-code` needs the author's linked login. */
  engine?: 'claude-code' | 'native';
  maxAttempts?: number;
  /** Longest a single correction run may take. */
  runTimeoutMs?: number;
}

/** Job options for a correction round: it consumed an attempt, so the queue must not retry it. */
export const AUTOFIX_ENQUEUE = { maxAttempts: 1 } as const;

export function queueAutofix(db: Database, changesetId: string): Promise<number | null> {
  return enqueue(
    db,
    'changeset.autofix',
    { changesetId },
    {
      ...AUTOFIX_ENQUEUE,
      dedupeKey: autofixDedupeKey(changesetId),
    },
  );
}

export interface RunOutcome {
  ok: boolean;
  detail?: string;
}

/**
 * One turn of the developer agent on a changeset clone: issues a short-lived session for the
 * changeset author, asks the agent-runner to run `prompt` and reads the result.
 */
export async function runDevAgent(
  db: Database,
  options: AutofixOptions,
  input: { changeset: typeof schema.changesets.$inferSelect; prompt: string },
): Promise<RunOutcome> {
  const { changeset } = input;
  let outcome: RunOutcome = { ok: false, detail: 'esecuzione terminata senza risultato' };
  for await (const event of streamAgentRun(
    db,
    {
      session: {
        uid: changeset.authorUid,
        agent: 'dev-agent',
        env: 'staging',
        changesetId: changeset.id,
        conversationId: changeset.conversationId,
      },
      engine:
        options.engine ?? (process.env.AUTOFIX_ENGINE === 'claude-code' ? 'claude-code' : 'native'),
      prompt: input.prompt,
    },
    {
      ...(options.runnerUrl ? { runnerUrl: options.runnerUrl } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      timeoutMs: options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
    },
  )) {
    if (event.type === 'error') outcome = { ok: false, detail: String(event.message) };
    else if (event.type === 'result') {
      outcome = {
        ok: event.stopReason !== 'error',
        detail:
          event.stopReason === 'error' ? String(event.detail ?? 'errore del motore') : undefined,
      };
    }
  }
  return outcome;
}

/**
 * The `changeset.autofix` job (FR-42): hands the errors of the failed checks to the developer
 * agent, which fixes the code in the changeset clone, then runs the checks again. Each round
 * uses one attempt; when they are over the changeset stays in `checks_failed` for a person.
 * Payload: `{ changesetId }`.
 */
export function autofixHandler(db: Database, options: AutofixOptions = {}): JobHandler {
  return async (payload) => {
    const changesetId = (payload as { changesetId?: unknown } | null)?.changesetId;
    if (!isChangesetId(changesetId)) throw new Error('payload.changesetId mancante');

    const maxAttempts = options.maxAttempts ?? maxAutofixAttempts();
    const plan = await planAutofix(db, changesetId, maxAttempts);
    const [changeset] = await db
      .select()
      .from(schema.changesets)
      .where(eq(schema.changesets.id, changesetId));
    if (!changeset) throw new Error(`Changeset ${changesetId} non trovato`);
    if (plan.action === 'none') return { skipped: plan.reason };
    if (plan.action === 'exhausted') {
      await writeAudit(db, {
        actorUid: changeset.authorUid,
        action: 'changeset.autofix',
        env: 'staging',
        outcome: 'error',
        details: { changesetId, exhausted: true, attempts: plan.attempts, maxAttempts },
      });
      return { exhausted: true, attempts: plan.attempts };
    }

    const outcome = await runDevAgent(db, options, {
      changeset,
      prompt: buildAutofixPrompt({
        title: changeset.title,
        attempt: plan.attempt,
        maxAttempts: plan.maxAttempts,
        failed: plan.failed,
      }),
    });

    await writeAudit(db, {
      actorUid: changeset.authorUid,
      action: 'changeset.autofix',
      env: 'staging',
      outcome: outcome.ok ? 'ok' : 'error',
      details: { changesetId, attempt: plan.attempt, maxAttempts, detail: outcome.detail ?? null },
    });
    // Whatever the agent did, the checks decide: a failed run costs an attempt and nothing else.
    await enqueue(
      db,
      'changeset.check',
      { changesetId },
      { dedupeKey: `changeset.check:${changesetId}` },
    );
    return { attempt: plan.attempt, ok: outcome.ok, detail: outcome.detail ?? null };
  };
}
