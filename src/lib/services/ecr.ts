import {
  ECRClient, DescribeRepositoriesCommand, CreateRepositoryCommand, DeleteRepositoryCommand, DescribeImagesCommand,
  BatchDeleteImageCommand, GetAuthorizationTokenCommand,
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
