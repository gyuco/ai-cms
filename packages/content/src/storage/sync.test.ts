import { randomBytes } from 'node:crypto';
import type { Principal } from '@ai-cms/authz';
import { seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getContent, publish, saveDraft } from '../service/index.ts';
import { createAssetStorage, ensureBuckets, openPublishedAsset, uploadAsset } from './index.ts';
import { syncProdToStaging } from './sync.ts';

const endpoint = process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:58333';
const s3Reachable = await fetch(endpoint, { signal: AbortSignal.timeout(1000) }).then(
  () => true,
  () => false,
);

const system: Principal = { uid: 1, username: 'system', status: 'active' };
const page = (title: string) => ({
  meta: { title },
  blocks: [{ id: 'h1', type: 'heading', level: 1, text: title }],
});

describe.skipIf(!testDatabaseUrl || !s3Reachable)('prod → staging sync', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const suffix = randomBytes(4).toString('hex');
  const storage = createAssetStorage({
    endpoint,
    accessKeyId: process.env.TEST_S3_ACCESS_KEY ?? 'test',
    secretAccessKey: process.env.TEST_S3_SECRET_KEY ?? 'testtesttest',
    buckets: { prod: `sync-prod-${suffix}`, staging: `sync-staging-${suffix}` },
  });

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async (p) => p });
    await ensureBuckets(storage);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('copies published production content and assets to staging', async () => {
    await saveDraft(database.db, system, 'prod', '/site/pages/index', page('Benvenuti'));
    await publish(database.db, system, 'prod', '/site/pages/index');
    const image = await sharp({
      create: { width: 40, height: 30, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    const asset = await uploadAsset(database.db, storage, system, 'prod', undefined, {
      filename: 'logo.png',
      contentType: 'image/png',
      data: image,
      alt: 'Logo',
    });

    const first = await syncProdToStaging(database.db, system, storage);
    expect(first.failed).toEqual([]);
    expect(first.updated).toContain('/site/pages/index');
    expect(first.copiedObjects).toBeGreaterThan(0);

    const staged = await getContent(database.db, system, 'staging', '/site/pages/index', {
      version: 'published',
    });
    expect(staged.body).toEqual(page('Benvenuti'));
    const file = await openPublishedAsset(database.db, storage, 'staging', asset.node.id);
    expect(file?.contentType).toMatch(/image/);

    const second = await syncProdToStaging(database.db, system, storage);
    expect(second.updated).toEqual([]);
    expect(second.unchanged).toBe(first.updated.length + first.unchanged);
  });
});
