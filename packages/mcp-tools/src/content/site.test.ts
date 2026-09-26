/**
 * Tools for the site, the assets and the publication (E9.1), against a real database.
 *
 * The storage is a stub: there is no S3 in this environment, and the point of these tests is
 * that the tool decodes the base64, hands the bytes to the storage service and reports back
 * the path, the URL and the state of the asset.
 */
import type { Principal } from '@ai-cms/authz';
import type { AssetStorage } from '@ai-cms/content/assets';
import { ensureSharedNodes, getContent, saveDraft } from '@ai-cms/content/service';
import { seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { NotFoundError, ValidationError, createNode } from '@ai-cms/tree';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ContentContext, ContentExtra, PageCheck } from './context.ts';
import { publishTool, updateLayoutTool, updateMenuTool, uploadAssetTool } from './site.ts';

const root: Principal = { uid: 0, username: 'root', status: 'active' };

/** Same helper as the asset storage tests: a real PNG, not bytes that only look like one. */
const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#3366cc' } })
    .png()
    .toBuffer();

interface RecordedCommand {
  name: string;
  input: { Bucket?: string; Key?: string; ContentType?: string; Body?: Buffer };
}

/**
 * Storage that only records what it is asked to do.
 *
 * The cast is legitimate: `AssetStorage` wants an `S3Client` and this is not one, but the
 * storage service only calls `send` with a command and reads the answer, and here we check
 * exactly that contract. `@aws-sdk/client-s3` is not a dependency of this package (cms-api
 * builds the real client), so the commands are recognized by name and read through `input`,
 * which every `Command` of the SDK exposes.
 */
function fakeStorage(): { storage: AssetStorage; commands: RecordedCommand[] } {
  const commands: RecordedCommand[] = [];
  const storage = {
    client: {
      send: async (command: unknown) => {
        const { constructor, input } = command as { constructor: { name: string }; input: never };
        commands.push({ name: constructor.name, input });
        if (constructor.name === 'PutObjectCommand') return { ETag: '"fake"' };
        if (constructor.name === 'HeadObjectCommand') return { ContentLength: 0 };
        return {};
      },
    } as unknown as AssetStorage['client'],
    buckets: { prod: 'x', staging: 'y' },
    maxBytes: 2 * 1024 * 1024,
  };
  return { storage, commands };
}

interface WriteResult {
  path: string;
  version: number;
  violations: string[];
  warnings: string[];
}

const asWriteResult = (result: unknown): WriteResult => result as WriteResult;

describe.skipIf(!testDatabaseUrl)('site, assets and publication tools', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const db = () => database.db;

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async (p) => `hash:${p}` });
  });

  afterAll(async () => {
    await database?.drop();
  });

  function context(overrides: Partial<ContentExtra> = {}): ContentContext {
    return {
      db: db(),
      principal: root,
      env: 'prod',
      toolCallId: 't1',
      conversationId: null,
      changesetId: null,
      storage: fakeStorage().storage,
      onPublished: vi.fn(async () => {}),
      validateRendered: async () => ({ errors: [] }),
      checkPage: async () => ({ errors: [], warnings: [] }),
      ...overrides,
    };
  }

  /** `run` answers `unknown`: this is how the tests read a thrown error. */
  const failure = (call: unknown): Promise<unknown> =>
    Promise.resolve(call).catch((e: unknown) => e);

  const newPage = async (name: string) => {
    await createNode(db(), root, 'prod', '/site/pages', { name, kind: 'page' });
    await saveDraft(db(), root, 'prod', `/site/pages/${name}`, {
      meta: { title: 'Chi siamo' },
      blocks: [],
    });
    return `/site/pages/${name}`;
  };

  describe('publish', () => {
    it('refuses to publish a version with blocking HTML errors and does not publish it (E6.7)', async () => {
      const path = await newPage('coi-errori');
      const validateRendered = vi.fn(async () => ({ errors: ['Manca il <title>.'] }));
      const ctx = context({ validateRendered });

      await expect(publishTool.run({ path }, ctx)).rejects.toThrow(ValidationError);
      const error = await failure(publishTool.run({ path }, ctx));
      expect((error as ValidationError).message).toContain('non è pubblicabile');
      // The user always sees why, not just a failure.
      expect((error as ValidationError).message).toContain('Manca il <title>.');
      expect((error as ValidationError).issues).toEqual(['Manca il <title>.']);
      // The version that would have gone online is the one that was checked.
      const snapshot = await getContent(db(), root, 'prod', path, { version: 'latest' });
      expect(validateRendered).toHaveBeenCalledWith(path, snapshot.body);
      // Nothing is online: the page has never been published.
      await expect(getContent(db(), root, 'prod', path, { version: 'published' })).rejects.toThrow(
        NotFoundError,
      );
      expect(ctx.onPublished).not.toHaveBeenCalled();
    });

    it('publishes the saved version and tells the site, with the result the agent needs', async () => {
      const path = await newPage('pubblicata');
      const onPublished = vi.fn(async () => {});
      const ctx = context({ onPublished });

      expect(await publishTool.run({ path }, ctx)).toEqual({
        path,
        status: 'published',
        version: 1,
        versionId: expect.any(Number),
      });
      expect(onPublished).toHaveBeenCalledWith([path], 'prod');
      const online = await getContent(db(), root, 'prod', path, { version: 'published' });
      expect(online).toMatchObject({ version: 1, published: true });

      // An explicit version number, and a hook that fails after the commit.
      await saveDraft(db(), root, 'prod', path, { meta: { title: 'Chi siamo' }, blocks: [] });
      const failing = context({ onPublished: async () => Promise.reject(new Error('sito giù')) });
      expect(await publishTool.run({ path, version: 1 }, failing)).toMatchObject({
        status: 'published',
        version: 1,
        hookError: 'sito giù',
      });
      await expect(publishTool.run({ path, version: 9 }, failing)).rejects.toThrow(NotFoundError);
    });
  });

  describe('update_layout', () => {
    it('creates the node when missing and saves the blocks as the body', async () => {
      const ctx = context();
      const blocks = [{ id: 'logo', type: 'heading', level: 1, text: 'Bottega' }] as const;
      const result = asWriteResult(
        await updateLayoutTool.run({ name: 'sidebar', blocks: [...blocks] }, ctx),
      );
      expect(result).toEqual({
        path: '/site/layouts/sidebar',
        version: 1,
        violations: [],
        warnings: [],
      });
      // The body of a layout is `{ blocks }`: the node did not exist, so it is version 1.
      const saved = await getContent(db(), root, 'prod', '/site/layouts/sidebar');
      expect(saved.body).toEqual({ blocks });
    });

    it('updates a layout that already exists instead of failing', async () => {
      await ensureSharedNodes(db(), root, 'prod');
      const result = asWriteResult(
        await updateLayoutTool.run(
          { name: 'header', blocks: [{ id: 'logo', type: 'heading', level: 1, text: 'Bottega' }] },
          context(),
        ),
      );
      expect(result).toMatchObject({ path: '/site/layouts/header', version: 1 });
    });

    it('returns the HTML violations of the layout, because header and footer are everywhere', async () => {
      const checks: { path: string; body: unknown }[] = [];
      // Stands in for `checkPageVersion`: renders the layout and reports the heading skip.
      const checkPage = async (path: string, body: unknown): Promise<PageCheck> => {
        checks.push({ path, body });
        const blocks = (body as { blocks: { type: string; level?: number }[] }).blocks;
        const levels = blocks.filter((b) => b.type === 'heading').map((b) => b.level ?? 0);
        const skipped = levels.some((level, i) => i > 0 && level > (levels[i - 1] ?? 0) + 1);
        return {
          errors: skipped
            ? [
                'Salto di livello nei titoli: qui ci si aspetta <h3>, invece c’è <h4>. I livelli dei titoli devono scendere di uno alla volta.',
              ]
            : [],
          warnings: ['Il titolo dell’intestazione è vuoto.'],
        };
      };

      const ctx = context({ checkPage });
      const result = asWriteResult(
        await updateLayoutTool.run(
          {
            name: 'footer',
            blocks: [
              { id: 'titolo', type: 'heading', level: 2, text: 'Contatti' },
              { id: 'diritto', type: 'heading', level: 4, text: 'Privacy' },
            ],
          },
          ctx,
        ),
      );
      expect(result.violations).toEqual([
        'Salto di livello nei titoli: qui ci si aspetta <h3>, invece c’è <h4>. I livelli dei titoli devono scendere di uno alla volta.',
      ]);
      expect(result.warnings).toEqual(['Il titolo dell’intestazione è vuoto.']);
      // The check runs on the version that was just saved, at the path the site renders.
      expect(checks).toHaveLength(1);
      expect(checks[0]!.path).toBe('/site/layouts/footer');
      expect(checks[0]!.body).toMatchObject({ blocks: [{ id: 'titolo' }, { id: 'diritto' }] });
    });

    it('refuses a stale expectedVersion instead of overwriting someone else', async () => {
      const result = asWriteResult(
        await updateLayoutTool.run(
          {
            name: 'sidebar',
            blocks: [{ id: 'a', type: 'heading', level: 1, text: 'Due' }],
            expectedVersion: 1,
          },
          context(),
        ),
      );
      expect(result.version).toBe(2);
      await expect(
        updateLayoutTool.run(
          {
            name: 'sidebar',
            blocks: [{ id: 'a', type: 'heading', level: 1, text: 'Tre' }],
            expectedVersion: 1,
          },
          context(),
        ),
      ).rejects.toThrow(/Conflitto/);
    });
  });

  describe('update_menu', () => {
    it('saves { items } and not a list of blocks', async () => {
      const items = [
        { label: 'Home', href: '/' },
        {
          label: 'Servizi',
          href: '/servizi',
          children: [{ label: 'Ristorazione', href: '/servizi/ristorazione' }],
        },
      ];
      const result = asWriteResult(await updateMenuTool.run({ name: 'main', items }, context()));
      expect(result).toMatchObject({ path: '/site/menus/main', version: 1, violations: [] });
      const saved = await getContent(db(), root, 'prod', '/site/menus/main');
      expect(saved.body).toEqual({ items });
    });

    it('rejects an invalid item, with the field that is wrong', async () => {
      await expect(
        updateMenuTool.run(
          {
            name: 'main',
            items: [
              { label: '', href: '/' },
              { label: 'X', href: 'javascript:x' },
            ],
          },
          context(),
        ),
      ).rejects.toThrow(ValidationError);
      const error = await failure(
        updateMenuTool.run({ name: 'main', items: [{ label: '', href: '/' }] }, context()),
      );
      expect((error as ValidationError).message).toContain('items[0].label');
      // The invalid write did not create a version.
      expect((await getContent(db(), root, 'prod', '/site/menus/main')).version).toBe(1);
    });
  });

  describe('upload_asset', () => {
    it('uploads the decoded bytes and answers with the path, the URL and the state', async () => {
      const fake = fakeStorage();
      const ctx = context({ storage: fake.storage });
      const data = await png(1200, 600);
      const result = (await uploadAssetTool.run(
        {
          filename: 'Hero Home.png',
          contentType: 'image/png',
          dataBase64: data.toString('base64'),
          alt: 'Un cielo blu',
        },
        ctx,
      )) as { path: string; url: string; version: number; published: boolean };

      expect(result).toMatchObject({ path: '/site/assets/hero-home', version: 1, published: true });
      const saved = await getContent(db(), root, 'prod', result.path);
      expect(result.url).toBe(`/_assets/${saved.node.id}`);
      expect(saved.body).toMatchObject({
        filename: 'Hero Home.png',
        contentType: 'image/png',
        width: 1200,
        height: 600,
        alt: 'Un cielo blu',
      });

      // The original went to the bucket of the environment, unchanged and with its own type.
      const puts = fake.commands.filter((c) => c.name === 'PutObjectCommand');
      const original = puts.find((c) => c.input.Key?.endsWith('/original.png'));
      expect(original).toMatchObject({ input: { Bucket: 'x', ContentType: 'image/png' } });
      expect(original!.input.Body).toEqual(data);
      // The variants are the webp the service generates, never enlarged.
      expect(puts.map((c) => c.input.Key?.split('/').pop()).sort()).toEqual([
        'optimized.webp',
        'original.png',
        'w480.webp',
        'w960.webp',
      ]);
      for (const variant of puts.filter((c) => c.input.Key?.endsWith('.webp'))) {
        expect(variant.input.ContentType).toBe('image/webp');
      }
    });

    it('refuses what the site refuses, before touching the storage', async () => {
      const fake = fakeStorage();
      const ctx = context({ storage: fake.storage });
      await expect(
        uploadAssetTool.run(
          {
            filename: 'logo.svg',
            contentType: 'image/png',
            dataBase64: Buffer.from('<svg/>').toString('base64'),
            alt: 'Logo',
          },
          ctx,
        ),
      ).rejects.toThrow(/immagine valida|non corrisponde/i);
      // An image without alt text is a WCAG problem: it needs `decorative: true` instead.
      await expect(
        uploadAssetTool.run(
          {
            filename: 'foto.png',
            contentType: 'image/png',
            dataBase64: (await png(10, 10)).toString('base64'),
          },
          ctx,
        ),
      ).rejects.toThrow(ValidationError);
      // SVG never reaches the tool: the input schema only allows the accepted types.
      expect(
        uploadAssetTool.input.safeParse({
          filename: 'a.svg',
          contentType: 'image/svg+xml',
          dataBase64: 'x',
        }).success,
      ).toBe(false);
      expect(fake.commands).toEqual([]);
    });
  });
});

describe('tool metadata', () => {
  it('declares the name, the permission and the required fields of every tool', () => {
    const tools = [publishTool, updateLayoutTool, updateMenuTool, uploadAssetTool];
    expect(tools.map((t) => [t.name, t.action])).toEqual([
      ['publish', 'publish'],
      ['update_layout', 'write'],
      ['update_menu', 'write'],
      ['upload_asset', 'create'],
    ]);
    for (const tool of tools) expect(tool.description.length).toBeGreaterThan(80);
    const fields = (tool: { input: z.ZodObject }) => Object.keys(tool.input.shape);
    expect(fields(publishTool)).toEqual(['path', 'version']);
    expect(fields(updateLayoutTool)).toEqual(['name', 'blocks', 'expectedVersion']);
    expect(fields(updateMenuTool)).toEqual(['name', 'items', 'expectedVersion']);
    expect(fields(uploadAssetTool)).toEqual([
      'filename',
      'contentType',
      'dataBase64',
      'alt',
      'decorative',
      'parent',
    ]);
  });

  it('describes blocks and content types to the model instead of hiding them', () => {
    const layout = z.toJSONSchema(updateLayoutTool.input, { io: 'input' }) as unknown as {
      properties: { blocks: { items: Record<string, unknown> | undefined } };
    };
    // A list of blocks the model can read, not an empty schema.
    expect(layout.properties.blocks.items).toBeDefined();
    const menu = JSON.stringify(z.toJSONSchema(updateMenuTool.input, { io: 'input' }));
    expect(menu).toContain('children');
    const asset = z.toJSONSchema(uploadAssetTool.input, { io: 'input' }) as unknown as {
      properties: { contentType: { enum: string[] } };
    };
    expect(asset.properties.contentType.enum).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/avif',
      'image/gif',
      'application/pdf',
      'video/mp4',
    ]);
  });
});
