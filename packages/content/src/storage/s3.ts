import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Env } from '@ai-cms/authz';
import type { Readable } from 'node:stream';

export const DEFAULT_ASSET_BUCKETS: Readonly<Record<Env, string>> = {
  prod: 'assets-prod',
  staging: 'assets-staging',
};

export const DEFAULT_MAX_ASSET_BYTES = 20 * 1024 * 1024;

export interface AssetStorageConfig {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  /** One bucket per environment; defaults to `assets-prod` and `assets-staging`. */
  buckets?: Partial<Record<Env, string>>;
  /** Upload size limit in bytes; default 20 MB. */
  maxBytes?: number;
}

export interface AssetStorage {
  client: S3Client;
  buckets: Record<Env, string>;
  maxBytes: number;
}

export function createAssetStorage(config: AssetStorageConfig): AssetStorage {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  return {
    client,
    buckets: { ...DEFAULT_ASSET_BUCKETS, ...config.buckets },
    maxBytes: config.maxBytes ?? DEFAULT_MAX_ASSET_BYTES,
  };
}

/** Creates the environment buckets if they are missing. */
export async function ensureBuckets(storage: AssetStorage): Promise<void> {
  for (const bucket of new Set(Object.values(storage.buckets))) {
    try {
      await storage.client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      try {
        await storage.client.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch (error) {
        // Another instance may have created it in the meantime.
        const name = (error as { name?: string }).name;
        if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error;
      }
    }
  }
}

export async function putObject(
  storage: AssetStorage,
  env: Env,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await storage.client.send(
    new PutObjectCommand({
      Bucket: storage.buckets[env],
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
}

export async function deleteObjects(storage: AssetStorage, env: Env, keys: string[]) {
  if (keys.length === 0) return;
  await storage.client.send(
    new DeleteObjectsCommand({
      Bucket: storage.buckets[env],
      Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
    }),
  );
}

export interface ObjectStream {
  stream: Readable;
  contentType: string;
  contentLength: number | undefined;
  etag: string | undefined;
}

export async function getObject(
  storage: AssetStorage,
  env: Env,
  key: string,
): Promise<ObjectStream> {
  const result = await storage.client.send(
    new GetObjectCommand({ Bucket: storage.buckets[env], Key: key }),
  );
  return {
    stream: result.Body as Readable,
    contentType: result.ContentType ?? 'application/octet-stream',
    contentLength: result.ContentLength,
    etag: result.ETag,
  };
}
