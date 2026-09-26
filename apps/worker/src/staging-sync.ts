import { createAssetStorage, ensureBuckets, syncProdToStaging } from '@ai-cms/content/assets';
import { readSecret, SYSTEM_UID, type Database } from '@ai-cms/db';
import type { JobHandler } from '@ai-cms/pipeline';

/** Job `staging.sync`: copies published production content and assets to staging. */
export function stagingSyncHandler(db: Database): JobHandler {
  return async () => {
    const storage = createAssetStorage({
      endpoint: process.env.S3_ENDPOINT ?? 'http://s3:8333',
      accessKeyId: readSecret('s3_access_key'),
      secretAccessKey: readSecret('s3_secret_key'),
    });
    await ensureBuckets(storage);
    return syncProdToStaging(
      db,
      { uid: SYSTEM_UID, username: 'system', status: 'active' },
      storage,
    );
  };
}
