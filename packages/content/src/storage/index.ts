// Asset storage on S3 (SeaweedFS): server only, behind `@ai-cms/content/assets`.
export {
  DEFAULT_ASSET_PARENT,
  assetNodeName,
  openPublishedAsset,
  readAsset,
  uploadAsset,
  type AssetFile,
  type UploadAssetInput,
  type UploadAssetOptions,
  type UploadedAsset,
} from './assets.ts';
export {
  DEFAULT_ASSET_BUCKETS,
  DEFAULT_MAX_ASSET_BYTES,
  createAssetStorage,
  ensureBuckets,
  type AssetStorage,
  type AssetStorageConfig,
  type ObjectStream,
} from './s3.ts';
