import {
  S3Client, ListBucketsCommand, CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, PutObjectCommand,
  DeleteObjectCommand, HeadObjectCommand, DeleteObjectsCommand, type BucketLocationConstraint,
} from '@aws-sdk/client-s3';
import { type ServiceModule, type Ctx, str, optStr, safeCount, InputError } from './types';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const s3Client = (ctx: Ctx) => ctx.client(S3Client, { forcePathStyle: true });

export const s3: ServiceModule = {
  async counts(ctx) {
    const c = s3Client(ctx);
    return [{ label: 'Buckets', value: await safeCount(async () => (await c.send(new ListBucketsCommand({}))).Buckets?.length ?? 0) }];
  },
  actions: {
    async list(ctx) {
      return (await s3Client(ctx).send(new ListBucketsCommand({}))).Buckets ?? [];
    },
    async createBucket(ctx, p) {
      const region = ctx.cfg.region;
      return s3Client(ctx).send(
        new CreateBucketCommand({
          Bucket: str(p, 'bucket'),
          CreateBucketConfiguration: region === 'us-east-1' ? undefined : { LocationConstraint: region as BucketLocationConstraint },
        }),
      );
    },
    async deleteBucket(ctx, p) {
      await s3Client(ctx).send(new DeleteBucketCommand({ Bucket: str(p, 'bucket') }));
      return { deleted: true };
    },
    async emptyBucket(ctx, p) {
      const Bucket = str(p, 'bucket');
      const c = s3Client(ctx);
      let deleted = 0;
      for (;;) {
        const r = await c.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1000 }));
        const keys = (r.Contents ?? []).map((o) => ({ Key: o.Key! }));
        if (!keys.length) break;
        await c.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys } }));
        deleted += keys.length;
        if (!r.IsTruncated) break;
      }
      return { deleted };
    },
    async listObjects(ctx, p) {
      const r = await s3Client(ctx).send(
        new ListObjectsV2Command({ Bucket: str(p, 'bucket'), Prefix: optStr(p, 'prefix'), Delimiter: '/', ContinuationToken: optStr(p, 'token'), MaxKeys: 500 }),
      );
      return { prefixes: (r.CommonPrefixes ?? []).map((x) => x.Prefix), objects: r.Contents ?? [], nextToken: r.NextContinuationToken, truncated: r.IsTruncated };
    },
    async head(ctx, p) {
      const r = await s3Client(ctx).send(new HeadObjectCommand({ Bucket: str(p, 'bucket'), Key: str(p, 'key') }));
      return { contentType: r.ContentType, contentLength: r.ContentLength, etag: r.ETag, lastModified: r.LastModified, metadata: r.Metadata, storageClass: r.StorageClass, versionId: r.VersionId };
    },
    async putObject(ctx, p) {
      const body = Buffer.from(str(p, 'base64', false), 'base64');
      if (body.length > MAX_UPLOAD_BYTES) throw new InputError('File is larger than 25 MB');
      return s3Client(ctx).send(
        new PutObjectCommand({ Bucket: str(p, 'bucket'), Key: str(p, 'key'), Body: body, ContentType: optStr(p, 'contentType') ?? 'application/octet-stream' }),
      );
    },
    async deleteObject(ctx, p) {
      await s3Client(ctx).send(new DeleteObjectCommand({ Bucket: str(p, 'bucket'), Key: str(p, 'key') }));
      return { deleted: true };
    },
  },
};
