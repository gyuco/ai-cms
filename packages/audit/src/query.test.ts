import { schema } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit } from './audit.ts';
import { parseAuditQuery, queryAudit } from './query.ts';

const q = (query: string) => parseAuditQuery(new URLSearchParams(query));

describe('parseAuditQuery', () => {
  it('reads every filter', () => {
    expect(
      q(
        'actor=anna&action=content.&path=/site/pages/&from=2026-09-01&to=2026-09-02&outcome=denied&cursor=40&limit=10',
      ),
    ).toEqual({
      ok: true,
      filters: {
        actor: 'anna',
        action: 'content.',
        path: 'site.pages',
        from: new Date('2026-09-01T00:00:00Z'),
        // A whole day: `to` is exclusive.
        to: new Date('2026-09-03T00:00:00Z'),
        outcome: 'denied',
      },
      cursor: 40,
      limit: 10,
    });
    expect(q('actor=&path=/&limit=5000')).toEqual({
      ok: true,
      filters: {},
      cursor: null,
      limit: 200,
    });
  });

  it('rejects invalid values with Italian messages', () => {
    expect(q('path=/Site Pages')).toEqual({
      ok: false,
      message: 'Percorso non valido: "/Site Pages".',
    });
    expect(q('from=ieri')).toMatchObject({
      ok: false,
      message: expect.stringContaining('AAAA-MM-GG'),
    });
    expect(q('outcome=forse')).toMatchObject({ ok: false });
    expect(q('cursor=-1')).toMatchObject({ ok: false });
    expect(q('limit=0')).toMatchObject({ ok: false });
  });
});

describe.skipIf(!testDatabaseUrl)('queryAudit', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const db = () => database.db;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.db
      .insert(schema.users)
      .values({ uid: 1000, username: 'anna', email: 'anna@x.test', status: 'active' });
    // An older entry, inserted as is: the log is append-only, `at` cannot be changed later.
    await database.db.insert(schema.auditLog).values({
      at: '2026-01-10T12:00:00.000Z',
      actorUid: 1000,
      action: 'auth.login',
      env: 'prod',
      outcome: 'ok',
      prevHash: '0'.repeat(64),
      hash: '1'.repeat(64),
    });
    const events = [
      { actorUid: 1000, action: 'content.write', nodePath: 'site.pages.blog', outcome: 'ok' },
      {
        actorUid: 1000,
        action: 'content.publish',
        nodePath: 'site.pages.blog.post',
        outcome: 'ok',
      },
      { actorUid: 1000, action: 'content.write', nodePath: 'site.settings', outcome: 'denied' },
      { actorUid: 4242, action: 'node.delete', nodePath: 'site.pages.blogroll', outcome: 'ok' },
    ] as const;
    for (const event of events) {
      await writeAudit(database.db, { env: 'prod', ...event });
    }
  });

  afterAll(async () => {
    await database?.drop();
  });

  const actions = (page: Awaited<ReturnType<typeof queryAudit>>) =>
    page.entries.map((e) => e.action);

  it('returns the newest entries first, with actor names and public paths', async () => {
    const page = await queryAudit(db(), {});
    expect(actions(page)).toEqual([
      'node.delete',
      'content.write',
      'content.publish',
      'content.write',
      'auth.login',
    ]);
    expect(page.entries[0]).toMatchObject({
      actorUid: 4242,
      actor: null,
      nodePath: '/site/pages/blogroll',
    });
    expect(page.entries[1]).toMatchObject({ actor: 'anna', outcome: 'denied', env: 'prod' });
    expect(page.entries[4]!.at).toBe('2026-01-10T12:00:00.000Z');
    expect(page.nextCursor).toBeNull();
  });

  it('pages by decreasing id', async () => {
    const first = await queryAudit(db(), {}, { limit: 2 });
    expect(actions(first)).toEqual(['node.delete', 'content.write']);
    expect(first.nextCursor).toBe(first.entries[1]!.id);
    const second = await queryAudit(db(), {}, { cursor: first.nextCursor, limit: 2 });
    expect(actions(second)).toEqual(['content.publish', 'content.write']);
    const last = await queryAudit(db(), {}, { cursor: second.nextCursor, limit: 2 });
    expect(actions(last)).toEqual(['auth.login']);
    expect(last.nextCursor).toBeNull();
  });

  it('filters by actor, action prefix, subtree, outcome and period', async () => {
    expect(actions(await queryAudit(db(), { actor: 'ANNA', action: 'content' }))).toEqual([
      'content.write',
      'content.publish',
      'content.write',
    ]);
    expect(actions(await queryAudit(db(), { actor: '4242' }))).toEqual(['node.delete']);
    // `site.pages.blog` does not match its sibling `site.pages.blogroll`.
    expect(actions(await queryAudit(db(), { path: 'site.pages.blog' }))).toEqual([
      'content.publish',
      'content.write',
    ]);
    expect(actions(await queryAudit(db(), { outcome: 'denied' }))).toEqual(['content.write']);
    expect(actions(await queryAudit(db(), { action: 'content_' }))).toEqual([]);
    const january = await queryAudit(db(), {
      from: new Date('2026-01-10T00:00:00Z'),
      to: new Date('2026-01-11T00:00:00Z'),
    });
    expect(actions(january)).toEqual(['auth.login']);
  });
});
