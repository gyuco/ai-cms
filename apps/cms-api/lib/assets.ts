import { createAssetStorage, ensureBuckets, type AssetStorage } from '@ai-cms/content/assets';
import { readSecret } from '@ai-cms/db';

let storage: Promise<AssetStorage> | undefined;

/** S3 storage for assets (SeaweedFS locally); buckets are created on first use. */
export function assetStorage(): Promise<AssetStorage> {
  storage ??= (async () => {
    const instance = createAssetStorage({
      endpoint: process.env.S3_ENDPOINT ?? 'http://s3:8333',
      accessKeyId: readSecret('s3_access_key'),
      secretAccessKey: readSecret('s3_secret_key'),
    });
    await ensureBuckets(instance);
    return instance;
  })();
  return storage;
}
