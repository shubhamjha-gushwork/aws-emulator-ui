import {
  ECSClient, ListClustersCommand, DescribeClustersCommand, CreateClusterCommand, DeleteClusterCommand, ListServicesCommand,
  DescribeServicesCommand, ListTasksCommand, DescribeTasksCommand, ListTaskDefinitionsCommand, DescribeTaskDefinitionCommand,
  RegisterTaskDefinitionCommand, RunTaskCommand, StopTaskCommand, CreateServiceCommand, UpdateServiceCommand, DeleteServiceCommand,
} from '@aws-sdk/client-ecs';
import { type ServiceModule, str, optStr, num, safeCount } from './types';

const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export const ecs: ServiceModule = {
  async counts(ctx) {
    const c = ctx.client(ECSClient);
    return [
      { label: 'Clusters', value: await safeCount(async () => (await c.send(new ListClustersCommand({}))).clusterArns?.length ?? 0) },
      { label: 'Task definitions', value: await safeCount(async () => (await c.send(new ListTaskDefinitionsCommand({}))).taskDefinitionArns?.length ?? 0) },
    ];
  },
  actions: {
    async clusters(ctx) {
      const c = ctx.client(ECSClient);
      const arns = (await c.send(new ListClustersCommand({}))).clusterArns ?? [];
      if (!arns.length) return [];
      const out = [];
      for (const part of chunk(arns, 100)) out.push(...((await c.send(new DescribeClustersCommand({ clusters: part }))).clusters ?? []));
      return out;
    },
    async createCluster(ctx, p) {
      return (await ctx.client(ECSClient).send(new CreateClusterCommand({ clusterName: str(p, 'name') }))).cluster;
    },
    async deleteCluster(ctx, p) {
      await ctx.client(ECSClient).send(new DeleteClusterCommand({ cluster: str(p, 'cluster') }));
      return { deleted: true };
    },
    async services(ctx, p) {
      const c = ctx.client(ECSClient);
      const cluster = str(p, 'cluster');
      const arns = (await c.send(new ListServicesCommand({ cluster }))).serviceArns ?? [];
      const out = [];
      for (const part of chunk(arns, 10)) out.push(...((await c.send(new DescribeServicesCommand({ cluster, services: part }))).services ?? []));
      return out;
    },
    async tasks(ctx, p) {
      const c = ctx.client(ECSClient);
      const cluster = str(p, 'cluster');
      const arns = (await c.send(new ListTasksCommand({ cluster, serviceName: optStr(p, 'service') }))).taskArns ?? [];
      const out = [];
      for (const part of chunk(arns, 100)) out.push(...((await c.send(new DescribeTasksCommand({ cluster, tasks: part }))).tasks ?? []));
      return out;
    },
    async taskDefinitions(ctx) {
      return (await ctx.client(ECSClient).send(new ListTaskDefinitionsCommand({ sort: 'DESC' }))).taskDefinitionArns ?? [];
    },
    async describeTaskDefinition(ctx, p) {
      return (await ctx.client(ECSClient).send(new DescribeTaskDefinitionCommand({ taskDefinition: str(p, 'taskDefinition') }))).taskDefinition;
    },
    async registerTaskDefinition(ctx, p) {
      const family = str(p, 'family');
      const r = await ctx.client(ECSClient).send(
        new RegisterTaskDefinitionCommand({
          family,
          requiresCompatibilities: ['FARGATE'],
          networkMode: 'awsvpc',
          cpu: optStr(p, 'cpu') ?? '256',
          memory: optStr(p, 'memory') ?? '512',
          containerDefinitions: [{ name: optStr(p, 'containerName') ?? family, image: str(p, 'image'), essential: true, portMappings: optStr(p, 'port') ? [{ containerPort: num(p, 'port') }] : undefined }],
        }),
      );
      return r.taskDefinition;
    },
    async runTask(ctx, p) {
      const subnets = optStr(p, 'subnet');
      const r = await ctx.client(ECSClient).send(
        new RunTaskCommand({
          cluster: str(p, 'cluster'),
          taskDefinition: str(p, 'taskDefinition'),
          launchType: 'FARGATE',
          count: 1,
          networkConfiguration: subnets ? { awsvpcConfiguration: { subnets: [subnets], assignPublicIp: 'DISABLED' } } : undefined,
        }),
      );
      return { tasks: r.tasks, failures: r.failures };
    },
    async stopTask(ctx, p) {
      return (await ctx.client(ECSClient).send(new StopTaskCommand({ cluster: str(p, 'cluster'), task: str(p, 'task'), reason: 'Stopped from AWS Emulator UI' }))).task;
    },
    async createService(ctx, p) {
      const subnet = optStr(p, 'subnet');
      return (
        await ctx.client(ECSClient).send(
          new CreateServiceCommand({
            cluster: str(p, 'cluster'),
            serviceName: str(p, 'name'),
            taskDefinition: str(p, 'taskDefinition'),
            desiredCount: num(p, 'desiredCount', 1),
            launchType: 'FARGATE',
            networkConfiguration: subnet ? { awsvpcConfiguration: { subnets: [subnet], assignPublicIp: 'DISABLED' } } : undefined,
          }),
        )
      ).service;
    },
    async scaleService(ctx, p) {
      return (await ctx.client(ECSClient).send(new UpdateServiceCommand({ cluster: str(p, 'cluster'), service: str(p, 'service'), desiredCount: num(p, 'desiredCount') }))).service;
    },
    async deleteService(ctx, p) {
      await ctx.client(ECSClient).send(new DeleteServiceCommand({ cluster: str(p, 'cluster'), service: str(p, 'service'), force: true }));
      return { deleted: true };
    },
  },
};
