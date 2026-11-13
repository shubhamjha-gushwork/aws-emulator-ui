import {
  DeregisterTaskDefinitionCommand,
  DeleteTaskDefinitionsCommand,
  ECSClient, ListClustersCommand, DescribeClustersCommand, CreateClusterCommand, DeleteClusterCommand, ListServicesCommand,
  DescribeServicesCommand, ListTasksCommand, DescribeTasksCommand, ListTaskDefinitionsCommand, DescribeTaskDefinitionCommand,
  RegisterTaskDefinitionCommand, RunTaskCommand, StopTaskCommand, CreateServiceCommand, UpdateServiceCommand, DeleteServiceCommand,
} from '@aws-sdk/client-ecs';
import { CloudWatchLogsClient, CreateLogGroupCommand } from '@aws-sdk/client-cloudwatch-logs';
import {
  EC2Client, DescribeSubnetsCommand, DescribeVpcsCommand, DescribeRouteTablesCommand, CreateInternetGatewayCommand,
  AttachInternetGatewayCommand, CreateRouteCommand,
} from '@aws-sdk/client-ec2';
import { type Ctx, type ServiceModule, str, optStr, num, bool, safeCount, inRegion, arnRegion, InputError } from './types';
import { roleOrHelper } from './iam-role';

const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
/**
 * Tasks in the default VPC's public subnets need a public IP to reach the registry (there's no NAT),
 * exactly as on AWS; without one every pull fails with CannotPullContainerError. Default to ENABLED.
 */
const publicIp = (p: Record<string, unknown>) => (p.assignPublicIp === false || p.assignPublicIp === 'DISABLED' ? 'DISABLED' : 'ENABLED');
/**
 * On AWS the default VPC has an internet gateway and a 0.0.0.0/0 route, so Fargate tasks with a public IP can
 * pull images. AWS Emulator's default VPC has neither, so every task stops with CannotPullContainerError
 * ("dial tcp …:443: i/o timeout") and services relaunch failing tasks until the emulator's 512-task cap is hit.
 * Before launching into a DEFAULT-VPC subnet we add the missing gateway + route once (only there, never in
 * VPCs you created). The emulator itself makes no outbound connection; this only satisfies its path check.
 */
export async function ensureDefaultVpcEgress(ctx: Ctx, subnetId: string): Promise<boolean> {
  const ec2 = ctx.client(EC2Client);
  const subnet = (await ec2.send(new DescribeSubnetsCommand({ SubnetIds: [subnetId] }))).Subnets?.[0];
  if (!subnet?.VpcId) return false;
  const vpc = (await ec2.send(new DescribeVpcsCommand({ VpcIds: [subnet.VpcId] }))).Vpcs?.[0];
  if (!vpc?.IsDefault) return false;
  const tables = (await ec2.send(new DescribeRouteTablesCommand({ Filters: [{ Name: 'vpc-id', Values: [subnet.VpcId] }] }))).RouteTables ?? [];
  const table = tables.find((t) => t.Associations?.some((a) => a.SubnetId === subnetId)) ?? tables.find((t) => t.Associations?.some((a) => a.Main));
  if (!table?.RouteTableId || table.Routes?.some((r) => r.DestinationCidrBlock === '0.0.0.0/0')) return false;
  const igw = (await ec2.send(new CreateInternetGatewayCommand({}))).InternetGateway?.InternetGatewayId;
  if (!igw) return false;
  await ec2.send(new AttachInternetGatewayCommand({ InternetGatewayId: igw, VpcId: subnet.VpcId }));
  await ec2.send(new CreateRouteCommand({ RouteTableId: table.RouteTableId, DestinationCidrBlock: '0.0.0.0/0', GatewayId: igw }));
  return true;
}

/** The emulator's task cap counts stopped tasks too; explain how to get out of it. */
async function withTaskCapHint<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (/at most \d+ tasks/.test((e as Error).message)) {
      throw Object.assign(new Error(`${(e as Error).message}. AWS Emulator counts STOPPED tasks toward this limit and never discards them; a service whose tasks keep failing to start fills it quickly. Delete the cluster that has many stopped tasks (see Tasks → Stopped) or restart the emulator.`), { name: (e as Error).name });
    }
    throw e;
  }
}

const local = (ctx: Ctx, arns: string[] | undefined) => (arns ?? []).filter((a) => inRegion(ctx, a));
const clusterArns = async (ctx: Ctx) => local(ctx, (await ctx.client(ECSClient).send(new ListClustersCommand({}))).clusterArns);
const taskDefArns = async (ctx: Ctx, sort?: 'ASC' | 'DESC') => local(ctx, (await ctx.client(ECSClient).send(new ListTaskDefinitionsCommand({ sort }))).taskDefinitionArns);

export const ecs: ServiceModule = {
  async counts(ctx) {
    return [
      { label: 'Clusters', value: await safeCount(async () => (await clusterArns(ctx)).length) },
      { label: 'Task definitions', value: await safeCount(async () => (await taskDefArns(ctx)).length) },
    ];
  },
  actions: {
    async clusters(ctx) {
      const c = ctx.client(ECSClient);
      const arns = await clusterArns(ctx);
      if (!arns.length) return [];
      const out = [];
      for (const part of chunk(arns, 100)) out.push(...((await c.send(new DescribeClustersCommand({ clusters: part }))).clusters ?? []));
      return out;
    },
    async createCluster(ctx, p) {
      const name = str(p, 'name');
      const cluster = (await ctx.client(ECSClient).send(new CreateClusterCommand({ clusterName: name }))).cluster;
      // The emulator keys ECS clusters by name across all regions: CreateCluster for a name that already exists
      // in another region silently returns that other region's cluster. Surface it instead of mixing regions.
      const r = arnRegion(cluster?.clusterArn);
      if (r && r !== ctx.cfg.region) {
        throw new InputError(`A cluster named "${name}" already exists in ${r}. AWS Emulator shares ECS cluster names across regions, so pick a different name for ${ctx.cfg.region}.`);
      }
      return cluster;
    },
    async deleteCluster(ctx, p) {
      await ctx.client(ECSClient).send(new DeleteClusterCommand({ cluster: str(p, 'cluster') }));
      return { deleted: true };
    },
    async services(ctx, p) {
      const c = ctx.client(ECSClient);
      const cluster = str(p, 'cluster');
      const arns = local(ctx, (await c.send(new ListServicesCommand({ cluster }))).serviceArns);
      const out = [];
      for (const part of chunk(arns, 10)) out.push(...((await c.send(new DescribeServicesCommand({ cluster, services: part }))).services ?? []));
      return out;
    },
    async tasks(ctx, p) {
      const c = ctx.client(ECSClient);
      const cluster = str(p, 'cluster');
      const desiredStatus = optStr(p, 'status') === 'STOPPED' ? 'STOPPED' : 'RUNNING';
      // Stopped tasks: the 100 most recent are enough to see why launches fail.
      const arns = local(ctx, (await c.send(new ListTasksCommand({ cluster, serviceName: optStr(p, 'service'), desiredStatus, maxResults: 100 }))).taskArns);
      const out = [];
      for (const part of chunk(arns, 100)) out.push(...((await c.send(new DescribeTasksCommand({ cluster, tasks: part }))).tasks ?? []));
      return out;
    },
    async taskDefinitions(ctx) {
      return taskDefArns(ctx, 'DESC');
    },
    async describeTaskDefinition(ctx, p) {
      return (await ctx.client(ECSClient).send(new DescribeTaskDefinitionCommand({ taskDefinition: str(p, 'taskDefinition') }))).taskDefinition;
    },
    async registerTaskDefinition(ctx, p) {
      const family = str(p, 'family');
      // Default to the awslogs driver writing to /ecs/<family>, like the AWS console does. The execution role
      // (pulls from ECR, writes awslogs) defaults to the UI's helper role.
      const logs = p.logs === undefined || bool(p, 'logs');
      const logGroup = optStr(p, 'logGroup') ?? `/ecs/${family}`;
      if (logs) {
        try {
          await ctx.client(CloudWatchLogsClient).send(new CreateLogGroupCommand({ logGroupName: logGroup }));
        } catch (e) {
          if ((e as Error).name !== 'ResourceAlreadyExistsException') throw e;
        }
      }
      const r = await ctx.client(ECSClient).send(
        new RegisterTaskDefinitionCommand({
          family,
          requiresCompatibilities: ['FARGATE'],
          executionRoleArn: await roleOrHelper(ctx, optStr(p, 'executionRoleArn')),
          networkMode: 'awsvpc',
          cpu: optStr(p, 'cpu') ?? '256',
          memory: optStr(p, 'memory') ?? '512',
          containerDefinitions: [{ name: optStr(p, 'containerName') ?? family, image: str(p, 'image'), essential: true, command: optStr(p, 'command') ? ['sh', '-c', str(p, 'command')] : undefined, portMappings: optStr(p, 'port') ? [{ containerPort: num(p, 'port') }] : undefined,
            logConfiguration: logs ? { logDriver: 'awslogs', options: { 'awslogs-group': logGroup, 'awslogs-region': ctx.cfg.region, 'awslogs-stream-prefix': 'ecs' } } : undefined }],
        }),
      );
      return r.taskDefinition;
    },
    async runTask(ctx, p) {
      const subnets = optStr(p, 'subnet');
      if (subnets && publicIp(p) === 'ENABLED') await ensureDefaultVpcEgress(ctx, subnets);
      const r = await withTaskCapHint(() => ctx.client(ECSClient).send(
        new RunTaskCommand({
          cluster: str(p, 'cluster'),
          taskDefinition: str(p, 'taskDefinition'),
          launchType: 'FARGATE',
          count: 1,
          networkConfiguration: subnets ? { awsvpcConfiguration: { subnets: [subnets], assignPublicIp: publicIp(p) } } : undefined,
        }),
      ));
      return { tasks: r.tasks, failures: r.failures };
    },
    /** Deregister a revision, then delete it (DeleteTaskDefinitions only accepts INACTIVE revisions). */
    async deregisterTaskDefinition(ctx, p) {
      const c = ctx.client(ECSClient);
      const taskDefinition = str(p, 'taskDefinition');
      await c.send(new DeregisterTaskDefinitionCommand({ taskDefinition }));
      await c.send(new DeleteTaskDefinitionsCommand({ taskDefinitions: [taskDefinition] })).catch(() => undefined);
      return { deregistered: true };
    },
    async stopTask(ctx, p) {
      return (await ctx.client(ECSClient).send(new StopTaskCommand({ cluster: str(p, 'cluster'), task: str(p, 'task'), reason: 'Stopped from AWS Emulator' }))).task;
    },
    async createService(ctx, p) {
      const subnet = optStr(p, 'subnet');
      if (subnet && publicIp(p) === 'ENABLED') await ensureDefaultVpcEgress(ctx, subnet);
      return (
        await withTaskCapHint(() => ctx.client(ECSClient).send(
          new CreateServiceCommand({
            cluster: str(p, 'cluster'),
            serviceName: str(p, 'name'),
            taskDefinition: str(p, 'taskDefinition'),
            desiredCount: num(p, 'desiredCount', 1),
            launchType: 'FARGATE',
            networkConfiguration: subnet ? { awsvpcConfiguration: { subnets: [subnet], assignPublicIp: publicIp(p) } } : undefined,
          }),
        ))
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
