import { randomUUID } from 'node:crypto';
import { ROOT_UID, schema, seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { autofixHandler } from './autofix.ts';

const ndjson = (...events: object[]) =>
  new Response(events.map((e) => JSON.stringify(e)).join('\n') + '\n', {
    headers: { 'content-type': 'application/x-ndjson' },
  });

describe.skipIf(!testDatabaseUrl)('changeset.autofix handler', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async () => 'x' });
  });

  afterAll(async () => {
    await database?.drop();
  });

  async function failedChangeset() {
    const id = randomUUID();
    const commit = 'b'.repeat(40);
    await database.db.insert(schema.changesets).values({
      id,
      title: 'Prenotazioni',
      branch: `cs/${id}`,
      baseCommit: commit,
      headCommit: commit,
      authorUid: ROOT_UID,
      status: 'checks_failed',
    });
    await database.db.insert(schema.checkRuns).values({
      changesetId: id,
      commit,
      checkName: 'lint',
      status: 'failed',
      output: 'no-unused-vars',
    });
    return id;
  }

  const queuedChecks = async (id: string) =>
    database.db
      .select()
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.type, 'changeset.check'),
          eq(schema.jobs.dedupeKey, `changeset.check:${id}`),
        ),
      );

  it('sends the errors to the developer agent and queues the checks again', async () => {
    const id = await failedChangeset();
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const handler = autofixHandler(database.db, {
      runnerUrl: 'http://runner:8070/',
      maxAttempts: 3,
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown> });
        return ndjson({ type: 'run', runId: 'r' }, { type: 'result', stopReason: 'end_turn' });
      }) as typeof fetch,
    });

    const result = await handler({ changesetId: id }, {} as never);

    expect(result).toMatchObject({ attempt: 1, ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('http://runner:8070/runs');
    expect(requests[0]!.body.prompt).toContain('no-unused-vars');
    expect(requests[0]!.body.prompt).toContain('tentativo di correzione 1 di 3');
    expect(await queuedChecks(id)).toHaveLength(1);
    // The one-shot session token does not outlive the run.
    const sessions = await database.db.select().from(schema.agentSessions);
    expect(sessions.filter((s) => s.changesetId === id)).toHaveLength(0);
  });

  it('counts a failed run as an attempt and still runs the checks', async () => {
    const id = await failedChangeset();
    const handler = autofixHandler(database.db, {
      maxAttempts: 3,
      fetch: (async () =>
        ndjson({ type: 'error', message: 'motore non raggiungibile' })) as typeof fetch,
    });
    const result = await handler({ changesetId: id }, {} as never);
    expect(result).toMatchObject({ attempt: 1, ok: false, detail: 'motore non raggiungibile' });
    expect(await queuedChecks(id)).toHaveLength(1);
  });

  it('stops after the last attempt without calling the agent', async () => {
    const id = await failedChangeset();
    let calls = 0;
    const handler = autofixHandler(database.db, {
      maxAttempts: 1,
      fetch: (async () => {
        calls += 1;
        return ndjson({ type: 'result', stopReason: 'end_turn' });
      }) as typeof fetch,
    });
    await handler({ changesetId: id }, {} as never);
    const result = await handler({ changesetId: id }, {} as never);
    expect(result).toMatchObject({ exhausted: true, attempts: 1 });
    expect(calls).toBe(1);
  });

  it('rejects a payload without a changeset', async () => {
    const handler = autofixHandler(database.db);
    await expect(handler({}, {} as never)).rejects.toThrow(/changesetId/);
  });
});
