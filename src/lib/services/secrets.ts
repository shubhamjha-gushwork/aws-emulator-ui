import {
  SecretsManagerClient, ListSecretsCommand, DescribeSecretCommand, GetSecretValueCommand, CreateSecretCommand,
  PutSecretValueCommand, DeleteSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import { type ServiceModule, str, optStr, bool, safeCount } from './types';

export const secrets: ServiceModule = {
  async counts(ctx) {
    const c = ctx.client(SecretsManagerClient);
    return [{ label: 'Secrets', value: await safeCount(async () => (await c.send(new ListSecretsCommand({ MaxResults: 100 }))).SecretList?.length ?? 0) }];
  },
  actions: {
    async list(ctx) {
      const c = ctx.client(SecretsManagerClient);
      const out = [];
      let NextToken: string | undefined;
      do {
        const r = await c.send(new ListSecretsCommand({ NextToken, MaxResults: 100 }));
        out.push(...(r.SecretList ?? []));
        NextToken = r.NextToken;
      } while (NextToken);
      return out;
    },
    async describe(ctx, p) {
      return ctx.client(SecretsManagerClient).send(new DescribeSecretCommand({ SecretId: str(p, 'id') }));
    },
    /** Only called when the user clicks "Reveal"; the list/describe calls never return values. */
    async getValue(ctx, p) {
      const r = await ctx.client(SecretsManagerClient).send(new GetSecretValueCommand({ SecretId: str(p, 'id') }));
      return { value: r.SecretString ?? (r.SecretBinary ? `<binary ${r.SecretBinary.length} bytes>` : ''), versionId: r.VersionId, stages: r.VersionStages, createdDate: r.CreatedDate };
    },
    async create(ctx, p) {
      const r = await ctx.client(SecretsManagerClient).send(
        new CreateSecretCommand({ Name: str(p, 'name'), SecretString: str(p, 'value'), Description: optStr(p, 'description') }),
      );
      return { arn: r.ARN, name: r.Name, versionId: r.VersionId };
    },
    async putValue(ctx, p) {
      const r = await ctx.client(SecretsManagerClient).send(new PutSecretValueCommand({ SecretId: str(p, 'id'), SecretString: str(p, 'value') }));
      return { arn: r.ARN, versionId: r.VersionId, stages: r.VersionStages };
    },
    async delete(ctx, p) {
      const force = bool(p, 'force');
      const r = await ctx.client(SecretsManagerClient).send(
        new DeleteSecretCommand({ SecretId: str(p, 'id'), ForceDeleteWithoutRecovery: force || undefined, RecoveryWindowInDays: force ? undefined : 7 }),
      );
      return { deletionDate: r.DeletionDate };
    },
  },
};
