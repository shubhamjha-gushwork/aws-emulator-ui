import {
  ECRClient, DescribeRepositoriesCommand, CreateRepositoryCommand, DeleteRepositoryCommand, DescribeImagesCommand,
  BatchDeleteImageCommand, GetAuthorizationTokenCommand, DescribeImageScanFindingsCommand, StartImageScanCommand,
} from '@aws-sdk/client-ecr';
import { type ServiceModule, str, bool, safeCount, inRegion } from './types';

export const ecr: ServiceModule = {
  async counts(ctx) {
    return [{ label: 'Repositories', value: await safeCount(async () => ((await ecr.actions.list(ctx, {})) as unknown[]).length) }];
  },
  actions: {
    async list(ctx) {
      const c = ctx.client(ECRClient);
      const out = [];
      let nextToken: string | undefined;
      do {
        const r = await c.send(new DescribeRepositoriesCommand({ nextToken }));
        out.push(...(r.repositories ?? []));
        nextToken = r.nextToken;
      } while (nextToken);
      return out.filter((r) => inRegion(ctx, r.repositoryArn));
    },
    async create(ctx, p) {
      return (
        await ctx.client(ECRClient).send(
          new CreateRepositoryCommand({ repositoryName: str(p, 'name'), imageTagMutability: bool(p, 'immutable') ? 'IMMUTABLE' : 'MUTABLE', imageScanningConfiguration: { scanOnPush: bool(p, 'scanOnPush') } }),
        )
      ).repository;
    },
    async delete(ctx, p) {
      await ctx.client(ECRClient).send(new DeleteRepositoryCommand({ repositoryName: str(p, 'name'), force: true }));
      return { deleted: true };
    },
    async images(ctx, p) {
      return (await ctx.client(ECRClient).send(new DescribeImagesCommand({ repositoryName: str(p, 'name') }))).imageDetails ?? [];
    },
    /** Scan status + findings of one image; NOT_SCANNED when the emulator has no scan for it (ScanNotFoundException). */
    async scanFindings(ctx, p) {
      try {
        const r = await ctx.client(ECRClient).send(new DescribeImageScanFindingsCommand({ repositoryName: str(p, 'name'), imageId: { imageDigest: str(p, 'digest') }, maxResults: 100 }));
        return { status: r.imageScanStatus?.status ?? 'UNKNOWN', description: r.imageScanStatus?.description, completedAt: r.imageScanFindings?.imageScanCompletedAt, severityCounts: r.imageScanFindings?.findingSeverityCounts ?? {}, findings: r.imageScanFindings?.findings ?? [] };
      } catch (e) {
        if ((e as Error).name === 'ScanNotFoundException') return { status: 'NOT_SCANNED', severityCounts: {}, findings: [] };
        throw e;
      }
    },
    async startScan(ctx, p) {
      const r = await ctx.client(ECRClient).send(new StartImageScanCommand({ repositoryName: str(p, 'name'), imageId: { imageDigest: str(p, 'digest') } }));
      return { status: r.imageScanStatus?.status, description: r.imageScanStatus?.description };
    },
    async deleteImage(ctx, p) {
      return ctx.client(ECRClient).send(new BatchDeleteImageCommand({ repositoryName: str(p, 'name'), imageIds: [{ imageDigest: str(p, 'digest') }] }));
    },
    async authToken(ctx) {
      const r = await ctx.client(ECRClient).send(new GetAuthorizationTokenCommand({}));
      const d = r.authorizationData?.[0];
      return { proxyEndpoint: d?.proxyEndpoint, expiresAt: d?.expiresAt, hasToken: Boolean(d?.authorizationToken) };
    },
  },
};
