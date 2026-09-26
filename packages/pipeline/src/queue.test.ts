import { schema } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claim, complete, enqueue, fail, retryDelayMs } from './queue.ts';
import { runWorker } from './worker.ts';

describe('retryDelayMs', () => {
  it('backs off exponentially up to ten minutes', () => {
    expect(retryDelayMs(1)).toBe(5_000);
    expect(retryDelayMs(2)).toBe(10_000);
    expect(retryDelayMs(30)).toBe(600_000);
  });
});

describe.skipIf(!testDatabaseUrl)('job queue', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('claims each job once, even with concurrent workers', async () => {
    for (let i = 0; i < 5; i++) await enqueue(database.db, 'test.claim', { i });
    const claimed = await Promise.all(
      Array.from({ length: 8 }, (_, w) => claim(database.db, `w${w}`, ['test.claim'])),
    );
    const ids = claimed.filter((j) => j !== null).map((j) => j!.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it('ignores duplicates of an active dedupe key', async () => {
    const first = await enqueue(database.db, 'test.dedupe', {}, { dedupeKey: 'k' });
    expect(first).not.toBeNull();
    expect(await enqueue(database.db, 'test.dedupe', {}, { dedupeKey: 'k' })).toBeNull();
    const job = await claim(database.db, 'w', ['test.dedupe']);
    await complete(database.db, job!.id);
    expect(await enqueue(database.db, 'test.dedupe', {}, { dedupeKey: 'k' })).not.toBeNull();
  });

  it('does not run jobs scheduled in the future', async () => {
    await enqueue(database.db, 'test.later', {}, { runAt: new Date(Date.now() + 60_000) });
    expect(await claim(database.db, 'w', ['test.later'])).toBeNull();
  });

  it('retries with backoff, then marks the job failed', async () => {
    const id = await enqueue(database.db, 'test.fail', {}, { maxAttempts: 2 });
    let job = await claim(database.db, 'w', ['test.fail']);
    await fail(database.db, job!, new Error('boom'));
    let [row] = await database.db.select().from(schema.jobs).where(eq(schema.jobs.id, id!));
    expect(row?.status).toBe('queued');
    expect(row!.runAt.getTime()).toBeGreaterThan(Date.now());

    await database.db.update(schema.jobs).set({ runAt: new Date() }).where(eq(schema.jobs.id, id!));
    job = await claim(database.db, 'w', ['test.fail']);
    await fail(database.db, job!, new Error('boom again'));
    [row] = await database.db.select().from(schema.jobs).where(eq(schema.jobs.id, id!));
    expect(row?.status).toBe('failed');
    expect(row?.lastError).toBe('boom again');
  });

  it('runs handlers as soon as jobs are enqueued', async () => {
    const controller = new AbortController();
    const seen: unknown[] = [];
    const worker = runWorker({
      db: database.db,
      sql: database.sql,
      handlers: {
        'test.run': async (payload) => {
          seen.push(payload);
          if (seen.length === 2) controller.abort();
          return { ok: true };
        },
      },
      // Short poll: the NOTIFY can arrive before LISTEN is set up.
      pollIntervalMs: 100,
      signal: controller.signal,
    });
    await enqueue(database.db, 'test.run', { n: 1 });
    await enqueue(database.db, 'test.run', { n: 2 });
    await worker;
    expect(seen).toHaveLength(2);
    expect(seen).toEqual(expect.arrayContaining([{ n: 1 }, { n: 2 }]));
  });
});
