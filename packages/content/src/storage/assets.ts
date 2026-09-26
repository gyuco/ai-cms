import type { Env, Principal } from '@ai-cms/authz';
import { schema } from '@ai-cms/db';
import {
  NotFoundError,
  ValidationError,
  authorizeOrAudit,
  createNode,
  joinLtree,
  nodeTarget,
  parsePath,
  requireNode,
  toTreeNode,
  type Executor,
  type TreeNode,
} from '@ai-cms/tree';
import { and, eq, isNull, like, or } from 'drizzle-orm';
import sharp, { type Metadata } from 'sharp';
import {
  ASSET_CONTENT_TYPES,
  IMAGE_VARIANT_WIDTHS,
  assetMediaType,
  getAssetUrl,
  parseAssetMeta,
  pickAssetVariant,
  type AssetContentType,
  type AssetMeta,
  type AssetVariant,
} from '../assets.ts';
import {
  insertVersion,
  publishVersion,
  resolveVersion,
  type ContentVersion,
  type SaveOptions,
} from '../service/versions.ts';
import { deleteObjects, getObject, putObject, type AssetStorage, type ObjectStream } from './s3.ts';

const { nodes, contentVersions, publications } = schema;

export const DEFAULT_ASSET_PARENT = '/site/assets';

export interface UploadAssetInput {
  filename: string;
  contentType: string;
  data: Buffer;
  /** Required for images unless `decorative` is true. */
  alt?: string;
  decorative?: boolean;
}

export interface UploadAssetOptions extends Pick<SaveOptions, 'viaAgent' | 'conversationId'> {
  /** Publish the metadata right away, so pages can use the asset. Default true. */
  publish?: boolean;
}

export interface UploadedAsset {
  node: TreeNode;
  meta: AssetMeta;
  version: ContentVersion;
  published: boolean;
  /** Public URL of the original file. */
  url: string;
}

const EXTENSIONS: Record<AssetContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
};

// What sharp reports for each accepted image type.
const SHARP_FORMATS: Partial<Record<AssetContentType, string>> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'heif',
  'image/gif': 'gif',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkContentType(input: string): AssetContentType {
  const type = input.split(';')[0]!.trim().toLowerCase();
  if (type === 'image/svg+xml') {
    throw new ValidationError(
      'Le immagini SVG non sono ammesse perché possono contenere script: usa PNG, WebP o AVIF.',
    );
  }
  if (!(ASSET_CONTENT_TYPES as readonly string[]).includes(type)) {
    throw new ValidationError(
      `Tipo di file non ammesso (${type || 'sconosciuto'}): sono accettate immagini JPEG, PNG, WebP, AVIF o GIF, documenti PDF e video MP4.`,
    );
  }
  return type as AssetContentType;
}

/** Node name from a file name: `Foto Mare.JPG` → `foto-mare`. */
export function assetNodeName(filename: string): string {
  const base = filename
    .replace(/\.[^.]*$/, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 56);
  return base || 'file';
}

async function freeName(db: Executor, parent: TreeNode, base: string): Promise<string> {
  const rows = await db
    .select({ name: nodes.name })
    .from(nodes)
    .where(
      and(
        eq(nodes.parentId, parent.id),
        isNull(nodes.deletedAt),
        or(eq(nodes.name, base), like(nodes.name, `${base}-%`)),
      ),
    );
  const taken = new Set(rows.map((r) => r.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
}

interface ProcessedFile {
  width?: number;
  height?: number;
  variants: { name: string; data: Buffer; width: number; height: number }[];
}

async function processImage(data: Buffer, contentType: AssetContentType): Promise<ProcessedFile> {
  const animated = contentType === 'image/gif' || contentType === 'image/webp';
  let metadata: Metadata;
  try {
    metadata = await sharp(data, { animated }).metadata();
  } catch {
    throw new ValidationError("Il file non è un'immagine valida.");
  }
  if (metadata.format !== SHARP_FORMATS[contentType]) {
    throw new ValidationError(
      `Il contenuto del file non corrisponde al tipo dichiarato (${contentType}).`,
    );
  }
  const rotate = (metadata.orientation ?? 1) >= 5;
  const rawHeight = metadata.pageHeight ?? metadata.height;
  const width = rotate ? rawHeight : metadata.width;
  const height = rotate ? metadata.width : rawHeight;

  const render = async (name: string, targetWidth?: number) => {
    let pipeline = sharp(data, { animated }).rotate();
    if (targetWidth) pipeline = pipeline.resize({ width: targetWidth, withoutEnlargement: true });
    const { data: out, info } = await pipeline
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    return { name, data: out, width: info.width, height: info.pageHeight ?? info.height };
  };
  const variants = [await render('optimized')];
  for (const target of IMAGE_VARIANT_WIDTHS) {
    if (target < width) variants.push(await render(`w${target}`, target));
  }
  return { width, height, variants };
}

function checkSignature(data: Buffer, contentType: AssetContentType): void {
  const ok =
    contentType === 'application/pdf'
      ? data.subarray(0, 5).toString('latin1') === '%PDF-'
      : data.subarray(4, 8).toString('latin1') === 'ftyp';
  if (!ok) {
    throw new ValidationError(
      `Il contenuto del file non corrisponde al tipo dichiarato (${contentType}).`,
    );
  }
}

/**
 * Uploads a file as an `asset` node (storage `s3`) under `parentPath` (default
 * `/site/assets`). Images get an optimized webp and resized variants; the metadata is saved
 * as the node's content and, by default, published.
 */
export async function uploadAsset(
  db: Executor,
  storage: AssetStorage,
  principal: Principal,
  env: Env,
  parentPath: string | undefined,
  input: UploadAssetInput,
  options: UploadAssetOptions = {},
): Promise<UploadedAsset> {
  const parentLtree = parsePath(parentPath ?? DEFAULT_ASSET_PARENT);
  const contentType = checkContentType(input.contentType);
  const mediaType = assetMediaType(contentType);
  const filename = input.filename.trim();
  if (filename === '') throw new ValidationError('Il nome del file è obbligatorio.');
  if (input.data.length === 0) throw new ValidationError('Il file è vuoto.');
  if (input.data.length > storage.maxBytes) {
    const mb = (storage.maxBytes / 1024 / 1024).toFixed(0);
    throw new ValidationError(`Il file supera la dimensione massima consentita (${mb} MB).`);
  }
  const alt = input.alt?.trim() ?? '';
  if (mediaType === 'image' && !input.decorative && alt === '') {
    throw new ValidationError(
      "Il testo alternativo è obbligatorio, a meno che l'immagine sia marcata come decorativa.",
    );
  }
  const shouldPublish = options.publish ?? true;

  // Authorize before the (expensive) image processing, outside the transaction so that
  // denials stay in the audit log.
  const parent = await requireNode(db, parentLtree, env);
  const baseName = assetNodeName(filename);
  const target = {
    path: joinLtree(parent.ltreePath, baseName),
    kind: 'asset',
    storage: 's3' as const,
  };
  await authorizeOrAudit(db, principal, 'create', nodeTarget(parent), env, 'asset.upload');
  await authorizeOrAudit(db, principal, 'create', target, env, 'asset.upload');
  if (shouldPublish) {
    await authorizeOrAudit(db, principal, 'publish', target, env, 'asset.upload');
  }

  let processed: ProcessedFile;
  if (mediaType === 'image') processed = await processImage(input.data, contentType);
  else {
    checkSignature(input.data, contentType);
    processed = { variants: [] };
  }

  const uploaded: string[] = [];
  try {
    return await db.transaction(async (tx) => {
      const name = await freeName(tx, parent, baseName);
      const node = await createNode(tx, principal, env, parent.path, {
        name,
        kind: 'asset',
        storage: 's3',
      });
      const key = `${node.id}/original.${EXTENSIONS[contentType]}`;
      await putObject(storage, env, key, input.data, contentType);
      uploaded.push(key);
      const variants: AssetVariant[] = [];
      for (const variant of processed.variants) {
        const variantKey = `${node.id}/${variant.name}.webp`;
        await putObject(storage, env, variantKey, variant.data, 'image/webp');
        uploaded.push(variantKey);
        variants.push({
          name: variant.name,
          key: variantKey,
          contentType: 'image/webp',
          width: variant.width,
          height: variant.height,
          size: variant.data.length,
        });
      }
      const meta: AssetMeta = {
        filename,
        contentType,
        mediaType,
        size: input.data.length,
        key,
        ...(processed.width ? { width: processed.width, height: processed.height } : {}),
        alt,
        ...(input.decorative ? { decorative: true } : {}),
        variants,
      };
      const version = await insertVersion(
        tx,
        principal,
        env,
        node,
        meta,
        { viaAgent: options.viaAgent, conversationId: options.conversationId },
        'asset.upload',
        { filename, contentType, size: input.data.length },
      );
      if (shouldPublish) await publishVersion(tx, principal, env, node, { versionId: version.id });
      return {
        node,
        meta: version.body as AssetMeta,
        version,
        published: shouldPublish,
        url: getAssetUrl(node.id),
      };
    });
  } catch (error) {
    await deleteObjects(storage, env, uploaded).catch(() => {});
    throw error;
  }
}

export interface AssetFile extends ObjectStream {
  filename: string;
  /** The variant actually served (it falls back to `optimized`, then `original`). */
  variant: string;
}

async function openFile(
  storage: AssetStorage,
  env: Env,
  body: unknown,
  variant: string | undefined,
): Promise<AssetFile> {
  const parsed = parseAssetMeta(body);
  if (!parsed.ok) throw new ValidationError('I metadati del file sono danneggiati.');
  const chosen = pickAssetVariant(parsed.value, variant);
  const object = await getObject(storage, env, chosen.key);
  return {
    ...object,
    contentType: chosen.contentType,
    filename: parsed.value.filename,
    variant: chosen.name,
  };
}

async function findAssetNode(db: Executor, ref: string, env: Env): Promise<TreeNode> {
  if (UUID.test(ref)) {
    const [row] = await db
      .select()
      .from(nodes)
      .where(
        and(
          eq(nodes.id, ref),
          isNull(nodes.deletedAt),
          or(eq(nodes.env, env), eq(nodes.env, 'both')),
        ),
      );
    if (!row || row.kind !== 'asset') throw new NotFoundError(`Il file ${ref} non esiste.`, ref);
    return toTreeNode(row);
  }
  const node = await requireNode(db, parsePath(ref), env);
  if (node.kind !== 'asset') throw new NotFoundError(`${node.path} non è un file.`, node.path);
  return node;
}

/**
 * Opens an asset file (latest metadata) for an authenticated principal, e.g. the CMS
 * preview. `ref` is the node id or its path.
 */
export async function readAsset(
  db: Executor,
  storage: AssetStorage,
  principal: Principal,
  env: Env,
  ref: string,
  variant?: string,
): Promise<AssetFile> {
  const node = await findAssetNode(db, ref, env);
  await authorizeOrAudit(db, principal, 'read', nodeTarget(node), env, 'asset.read');
  const version = await resolveVersion(db, node, env, 'latest');
  return openFile(storage, env, version.body, variant);
}

/**
 * Opens a published asset for public serving by the site: no principal, only assets whose
 * metadata is published in `env`. Returns null when there is nothing to serve.
 */
export async function openPublishedAsset(
  db: Executor,
  storage: AssetStorage,
  env: Env,
  id: string,
  variant?: string,
): Promise<AssetFile | null> {
  if (!UUID.test(id)) return null;
  const [row] = await db
    .select({ body: contentVersions.body })
    .from(publications)
    .innerJoin(nodes, eq(nodes.id, publications.nodeId))
    .innerJoin(contentVersions, eq(contentVersions.id, publications.versionId))
    .where(
      and(
        eq(publications.nodeId, id),
        eq(publications.env, env),
        eq(publications.status, 'published'),
        eq(nodes.kind, 'asset'),
        isNull(nodes.deletedAt),
      ),
    );
  if (!row) return null;
  return openFile(storage, env, row.body, variant);
}
