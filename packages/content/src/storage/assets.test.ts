import { randomBytes } from 'node:crypto';
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { AuthzError, type Principal } from '@ai-cms/authz';
import { schema, seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { ValidationError } from '@ai-cms/tree';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assetSrcSet, getAssetUrl, parseAssetMeta } from '../assets.ts';
import { getContent, saveDraft } from '../service/index.ts';
import {
  assetNodeName,
  createAssetStorage,
  ensureBuckets,
  openPublishedAsset,
  readAsset,
  uploadAsset,
  type AssetStorage,
} from './index.ts';

const endpoint = process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:58333';
const s3Reachable = await fetch(endpoint, { signal: AbortSignal.timeout(1000) }).then(
  () => true,
  () => false,
);

const root: Principal = { uid: 0, username: 'root', status: 'active' };

async function streamToBuffer(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('asset helpers', () => {
  it('derives node names from file names', () => {
    expect(assetNodeName('Foto Mare.JPG')).toBe('foto-mare');
    expect(assetNodeName('Città_2024 (1).png')).toBe('citta_2024-1');
    expect(assetNodeName('...')).toBe('file');
  });

  it('builds URLs and srcset', () => {
    expect(getAssetUrl('abc')).toBe('/_assets/abc');
    expect(getAssetUrl('abc', 'w480', '/media/')).toBe('/media/abc/w480');
    const meta = parseAssetMeta({
      filename: 'a.png',
      contentType: 'image/png',
      mediaType: 'image',
      size: 10,
      key: 'k',
      alt: 'A',
      variants: [
        { name: 'w960', key: 'k2', contentType: 'image/webp', width: 960, height: 1, size: 1 },
        { name: 'w480', key: 'k1', contentType: 'image/webp', width: 480, height: 1, size: 1 },
        {
          name: 'optimized',
          key: 'k3',
          contentType: 'image/webp',
          width: 1000,
          height: 1,
          size: 1,
        },
      ],
    });
    expect(meta.ok).toBe(true);
    if (meta.ok) {
      expect(assetSrcSet('abc', meta.value)).toBe('/_assets/abc/w480 480w, /_assets/abc/w960 960w');
    }
  });

  it('requires alt text for images unless decorative', () => {
    const base = {
      filename: 'a.png',
      contentType: 'image/png',
      mediaType: 'image',
      size: 1,
      key: 'k',
      alt: '',
      variants: [],
    };
    expect(parseAssetMeta(base).ok).toBe(false);
    expect(parseAssetMeta({ ...base, decorative: true }).ok).toBe(true);
    expect(parseAssetMeta({ ...base, contentType: 'image/svg+xml' }).ok).toBe(false);
  });
});

describe.skipIf(!testDatabaseUrl || !s3Reachable)('asset storage (S3)', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let storage: AssetStorage;
  const db = () => database.db;
  const suffix = randomBytes(4).toString('hex');

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async (p) => `hash:${p}` });
    storage = createAssetStorage({
      endpoint,
      accessKeyId: process.env.TEST_S3_ACCESS_KEY ?? 'test',
      secretAccessKey: process.env.TEST_S3_SECRET_KEY ?? 'testtesttest',
      buckets: { prod: `test-prod-${suffix}`, staging: `test-staging-${suffix}` },
      maxBytes: 2 * 1024 * 1024,
    });
    await ensureBuckets(storage);
    await ensureBuckets(storage); // idempotent
  });

  afterAll(async () => {
    if (storage) {
      for (const bucket of Object.values(storage.buckets)) {
        const listed = await storage.client.send(new ListObjectsV2Command({ Bucket: bucket }));
        const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key! }));
        if (keys.length > 0) {
          await storage.client.send(
            new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }),
          );
        }
        await storage.client.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => {});
      }
    }
    await database?.drop();
  });

  const png = (width: number, height: number) =>
    sharp({ create: { width, height, channels: 3, background: '#3366cc' } })
      .png()
      .toBuffer();

  it('uploads an image with an optimized webp and resized variants, never enlarged', async () => {
    const data = await png(1200, 600);
    const asset = await uploadAsset(db(), storage, root, 'prod', undefined, {
      filename: 'Hero Home.png',
      contentType: 'image/png',
      data,
      alt: 'Un cielo blu',
    });
    expect(asset.node).toMatchObject({
      path: '/site/assets/hero-home',
      kind: 'asset',
      storage: 's3',
    });
    expect(asset.meta).toMatchObject({
      filename: 'Hero Home.png',
      contentType: 'image/png',
      mediaType: 'image',
      width: 1200,
      height: 600,
      alt: 'Un cielo blu',
      size: data.length,
    });
    expect(asset.meta.variants.map((v) => [v.name, v.width, v.height])).toEqual([
      ['optimized', 1200, 600],
      ['w480', 480, 240],
      ['w960', 960, 480],
    ]);
    expect(asset.published).toBe(true);
    expect(asset.url).toBe(`/_assets/${asset.node.id}`);

    const file = await openPublishedAsset(db(), storage, 'prod', asset.node.id, 'w480');
    expect(file).toMatchObject({ contentType: 'image/webp', variant: 'w480' });
    const bytes = await streamToBuffer(file!.stream);
    expect((await sharp(bytes).metadata()).width).toBe(480);

    // w1920 does not exist for a 1200px image: the optimized version is served.
    const fallback = await openPublishedAsset(db(), storage, 'prod', asset.node.id, 'w1920');
    expect(fallback!.variant).toBe('optimized');
    await streamToBuffer(fallback!.stream);

    const original = await readAsset(db(), storage, root, 'prod', '/site/assets/hero-home');
    expect(original.contentType).toBe('image/png');
    expect(await streamToBuffer(original.stream)).toEqual(data);
    // Not published in staging.
    expect(await openPublishedAsset(db(), storage, 'staging', asset.node.id)).toBeNull();
  });

  it('gives each upload a free name and accepts decorative images without alt', async () => {
    const asset = await uploadAsset(db(), storage, root, 'prod', '/site/assets', {
      filename: 'hero-home.png',
      contentType: 'image/png',
      data: await png(40, 20),
      decorative: true,
    });
    expect(asset.node.name).toBe('hero-home-2');
    expect(asset.meta).toMatchObject({ decorative: true, alt: '' });
    expect(asset.meta.variants.map((v) => v.name)).toEqual(['optimized']);
  });

  it('stores PDFs without variants and lets alt text be edited as content', async () => {
    const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
    const asset = await uploadAsset(db(), storage, root, 'staging', undefined, {
      filename: 'listino.pdf',
      contentType: 'application/pdf',
      data: pdf,
    });
    expect(asset.meta).toMatchObject({ mediaType: 'document', variants: [], alt: '' });
    await saveDraft(db(), root, 'staging', asset.node.path, { ...asset.meta, alt: 'Listino' });
    const content = await getContent(db(), root, 'staging', asset.node.path);
    expect(content).toMatchObject({ version: 2, body: { alt: 'Listino' } });
  });

  it('rejects SVG, unknown types, oversized files, mismatched content and missing alt', async () => {
    const upload = (input: Partial<Parameters<typeof uploadAsset>[5]>) =>
      uploadAsset(db(), storage, root, 'prod', undefined, {
        filename: 'x.png',
        contentType: 'image/png',
        data: Buffer.from('x'),
        alt: 'x',
        ...input,
      });
    await expect(
      upload({ contentType: 'image/svg+xml', data: Buffer.from('<svg/>') }),
    ).rejects.toThrow(/SVG/);
    await expect(upload({ contentType: 'text/html' })).rejects.toThrow(/non ammesso/);
    await expect(upload({ data: Buffer.alloc(3 * 1024 * 1024) })).rejects.toThrow(/2 MB/);
    await expect(upload({ data: Buffer.from('not an image') })).rejects.toThrow(/immagine valida/);
    await expect(upload({ contentType: 'image/jpeg', data: await png(10, 10) })).rejects.toThrow(
      /non corrisponde/,
    );
    await expect(upload({ data: await png(10, 10), alt: ' ' })).rejects.toThrow(ValidationError);
    await expect(
      upload({ contentType: 'video/mp4', filename: 'v.mp4', data: Buffer.from('nope-nope') }),
    ).rejects.toThrow(/non corrisponde/);
  });

  it('checks authorization before storing anything and audits the upload', async () => {
    const suspended: Principal = { ...root, status: 'suspended' };
    await expect(
      uploadAsset(db(), storage, suspended, 'prod', undefined, {
        filename: 'y.png',
        contentType: 'image/png',
        data: await png(10, 10),
        alt: 'y',
      }),
    ).rejects.toThrow(AuthzError);
    const audit = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'asset.upload'));
    expect(audit.filter((r) => r.outcome === 'ok')).toHaveLength(3);
    expect(audit.filter((r) => r.outcome === 'denied')).toHaveLength(1);
  });

  it('removes the objects already stored when a later step fails', async () => {
    const count = async () =>
      (await storage.client.send(new ListObjectsV2Command({ Bucket: storage.buckets.prod })))
        .KeyCount ?? 0;
    const before = await count();
    let puts = 0;
    const flaky = {
      ...storage,
      client: {
        send: async (command: unknown) => {
          if (command instanceof PutObjectCommand && ++puts === 2)
            throw new Error('S3 non risponde');
          return storage.client.send(command as PutObjectCommand);
        },
      } as unknown as AssetStorage['client'],
    };
    await expect(
      uploadAsset(db(), flaky, root, 'prod', undefined, {
        filename: 'z.png',
        contentType: 'image/png',
        data: await png(10, 10),
        alt: 'z',
      }),
    ).rejects.toThrow('S3 non risponde');
    expect(puts).toBe(2);
    expect(await count()).toBe(before);
    const rows = await db().select().from(schema.nodes).where(eq(schema.nodes.name, 'z'));
    expect(rows).toHaveLength(0);
  });
});
