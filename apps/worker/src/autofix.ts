import { issueAgentSession, revokeAgentSession } from '@ai-cms/ai-config';
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

const DEFAULT_RUN_TIMEOUT_MS = 20 * 60_000;

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

interface RunOutcome {
  ok: boolean;
  detail?: string;
}

/** Reads the NDJSON stream of a run until its end. */
async function consumeRun(response: Response): Promise<RunOutcome> {
  if (!response.body) return { ok: false, detail: 'risposta vuota' };
  const decoder = new TextDecoder();
  let buffer = '';
  let outcome: RunOutcome = { ok: false, detail: 'esecuzione terminata senza risultato' };
  const handle = (line: string) => {
    if (!line.trim()) return;
    let event: { type?: string; message?: string; stopReason?: string; detail?: string };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      return;
    }
    if (event.type === 'error') outcome = { ok: false, detail: event.message };
    else if (event.type === 'result') {
      outcome = {
        ok: event.stopReason !== 'error',
        detail: event.stopReason === 'error' ? (event.detail ?? 'errore del motore') : undefined,
      };
    }
  };
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach(handle);
  }
  handle(buffer);
  return outcome;
}

/**
 * The `changeset.autofix` job (FR-42): hands the errors of the failed checks to the developer
 * agent, which fixes the code in the changeset clone, then runs the checks again. Each round
 * uses one attempt; when they are over the changeset stays in `checks_failed` for a person.
 * Payload: `{ changesetId }`.
 */
export function autofixHandler(db: Database, options: AutofixOptions = {}): JobHandler {
  const runnerUrl = (
    options.runnerUrl ??
    process.env.AGENT_RUNNER_URL ??
    'http://agent-runner:8070'
  ).replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
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

    const { token } = await issueAgentSession(db, {
      uid: changeset.authorUid,
      agent: 'dev-agent',
      env: 'staging',
      changesetId,
      conversationId: changeset.conversationId,
      ttlMs: (options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS) + 60_000,
    });
    let outcome: RunOutcome;
    try {
      const response = await doFetch(`${runnerUrl}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token,
          engine:
            options.engine ??
            (process.env.AUTOFIX_ENGINE === 'claude-code' ? 'claude-code' : 'native'),
          prompt: buildAutofixPrompt({
            title: changeset.title,
            attempt: plan.attempt,
            maxAttempts: plan.maxAttempts,
            failed: plan.failed,
          }),
        }),
        signal: AbortSignal.timeout(options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS),
      });
      outcome = response.ok
        ? await consumeRun(response)
        : { ok: false, detail: `l'agent-runner ha risposto ${String(response.status)}` };
    } catch (error) {
      outcome = { ok: false, detail: (error as Error).message };
    } finally {
      await revokeAgentSession(db, token).catch(() => undefined);
    }

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
