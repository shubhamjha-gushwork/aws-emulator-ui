import { DeleteEventSourceMappingCommand, DeleteFunctionCommand, ListEventSourceMappingsCommand } from '@aws-sdk/client-lambda';
import { DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { DeleteTopicCommand } from '@aws-sdk/client-sns';
import { DeleteBucketCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DeleteSecretCommand } from '@aws-sdk/client-secrets-manager';
import { DeleteLogGroupCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DeleteEventBusCommand, DeleteRuleCommand, RemoveTargetsCommand, ListTargetsByRuleCommand } from '@aws-sdk/client-eventbridge';
import { DeleteRestApiCommand } from '@aws-sdk/client-api-gateway';
import { DeleteApiCommand } from '@aws-sdk/client-apigatewayv2';
import { DeleteStateMachineCommand } from '@aws-sdk/client-sfn';
import {
  DeleteClusterCommand, DeleteServiceCommand, DeregisterTaskDefinitionCommand, ListTaskDefinitionsCommand, UpdateServiceCommand, ListTasksCommand, ListServicesCommand, StopTaskCommand,
} from '@aws-sdk/client-ecs';
import { DeleteRepositoryCommand } from '@aws-sdk/client-ecr';
import { DeleteLoadBalancerCommand, DeleteTargetGroupCommand, DeleteListenerCommand, DescribeListenersCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import type { DeployClients } from './client';
import { makeClients } from './client';
import { deleteManifest, listManifests, readManifest, writeManifest } from './state';
import type { DeployManifest, DeployOptions, ManifestResource } from './types';

export async function destroyManifest(clients: DeployClients, manifest: DeployManifest): Promise<{ ok: string[]; failed: { name: string; error: string }[]; kept: string[] }> {
  const { own, shared } = splitShared(manifest.resources, manifest.id, manifest.region);
  const r = await destroyResources(clients, own);
  return { ...r, kept: shared.map((s) => `${s.resource.kind}:${s.resource.name} (also in ${s.by})`) };
}

/**
 * Separate resources another recorded deployment in the same region also lists (e.g. one secret
 * shared by several repos, or two configs on one cluster). Deleting those would break the other deploy.
 */
export function splitShared(resources: ManifestResource[], selfId: string, region: string | undefined, manifests: DeployManifest[] = listManifests()): { own: ManifestResource[]; shared: { resource: ManifestResource; by: string }[] } {
  const reg = region || 'us-east-1';
  const usedBy = new Map<string, string>();
  for (const m of manifests) {
    if (m.id === selfId || (m.region || 'us-east-1') !== reg) continue;
    for (const r of m.resources) if (!usedBy.has(resourceKey(r))) usedBy.set(resourceKey(r), m.id);
  }
  const own: ManifestResource[] = [];
  const shared: { resource: ManifestResource; by: string }[] = [];
  for (const r of resources) {
    const by = usedBy.get(resourceKey(r));
    if (by) shared.push({ resource: r, by });
    else own.push(r);
  }
  return { own, shared };
}

/** Identity of a manifest entry; used to dedupe and to find resources a redeploy no longer creates. */
export function resourceKey(r: ManifestResource): string {
  return `${r.kind}:${r.name}${r.kind === 'event-source-mapping' ? `:${r.arn ?? ''}` : ''}${r.extra?.bus ? `@${r.extra.bus}` : ''}`;
}

export function dedupeResources(list: ManifestResource[]): ManifestResource[] {
  const seen = new Map<string, ManifestResource>();
  for (const r of list) seen.set(resourceKey(r), r);
  return [...seen.values()];
}

export async function destroyResources(clients: DeployClients, all: ManifestResource[]): Promise<{ ok: string[]; failed: { name: string; error: string }[] }> {
  const ok: string[] = [];
  const failed: { name: string; error: string }[] = [];
  const order: ManifestResource['kind'][] = [
    'listener', 'ecs-service', 'scheduler', 'event-rule', 'event-bus', 'event-source-mapping',
    'alb', 'target-group', 'lambda', 'sfn', 'apigateway', 'apigatewayv2',
    'ecs-task-definition', 'ecs-cluster', 'ecr', 'sqs', 'sns', 'dynamodb', 's3', 'secret', 'log-group', 'other',
  ];
  const rank = (k: string) => { const i = order.indexOf(k as ManifestResource['kind']); return i < 0 ? 99 : i; };
  const resources = dedupeResources(all).sort((a, b) => rank(a.kind) - rank(b.kind));
  const fallbackCluster = all.find((r) => r.kind === 'ecs-cluster')?.name;
  for (const r of resources) {
    try {
      await destroyOne(clients, r, fallbackCluster);
      ok.push(`${r.kind}:${r.name}`);
    } catch (e) {
      if (isAlreadyGone(e)) ok.push(`${r.kind}:${r.name}`);
      else failed.push({ name: `${r.kind}:${r.name}`, error: (e as Error).message });
    }
  }
  return { ok, failed };
}

async function destroyOne(c: DeployClients, r: ManifestResource, fallbackCluster?: string) {
  switch (r.kind) {
    case 'lambda': {
      // Floci keeps a function's SQS mappings after the function is deleted; remove them first.
      const maps = await c.lambda.send(new ListEventSourceMappingsCommand({ FunctionName: r.name })).catch(() => undefined);
      for (const m of maps?.EventSourceMappings ?? []) if (m.UUID) await c.lambda.send(new DeleteEventSourceMappingCommand({ UUID: m.UUID })).catch(() => undefined);
      await c.lambda.send(new DeleteFunctionCommand({ FunctionName: r.name }));
      await c.logs.send(new DeleteLogGroupCommand({ logGroupName: `/aws/lambda/${r.name}` })).catch(() => undefined);
      break;
    }
    case 'event-source-mapping': {
      const fn = r.extra?.function || r.name;
      const maps = await c.lambda.send(new ListEventSourceMappingsCommand({ FunctionName: fn, EventSourceArn: r.arn })).catch(() => undefined);
      for (const m of maps?.EventSourceMappings ?? []) if (m.UUID) await c.lambda.send(new DeleteEventSourceMappingCommand({ UUID: m.UUID }));
      break;
    }
    case 'event-bus':
      if (r.name !== 'default') await c.events.send(new DeleteEventBusCommand({ Name: r.name }));
      break;
    case 'ecs-task-definition': {
      const family = r.name;
      let token: string | undefined;
      do {
        const listed = await c.ecs.send(new ListTaskDefinitionsCommand({ familyPrefix: family, status: 'ACTIVE', nextToken: token }));
        for (const arn of listed.taskDefinitionArns ?? []) {
          // familyPrefix is a prefix match; only deregister this exact family.
          if (arn.split('/').pop()?.replace(/:\d+$/, '') === family) await c.ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition: arn }));
        }
        token = listed.nextToken;
      } while (token);
      break;
    }
    case 'sqs':
      if (r.url) await c.sqs.send(new DeleteQueueCommand({ QueueUrl: r.url }));
      break;
    case 'sns':
      if (r.arn) await c.sns.send(new DeleteTopicCommand({ TopicArn: r.arn }));
      break;
    case 's3': {
      let token: string | undefined;
      do {
        const listed = await c.s3.send(new ListObjectsV2Command({ Bucket: r.name, ContinuationToken: token }));
        if (listed.Contents?.length) {
          await c.s3.send(new DeleteObjectsCommand({ Bucket: r.name, Delete: { Objects: listed.Contents.map((o) => ({ Key: o.Key! })) } }));
        }
        token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (token);
      await c.s3.send(new DeleteBucketCommand({ Bucket: r.name }));
      break;
    }
    case 'dynamodb':
      await c.ddb.send(new DeleteTableCommand({ TableName: r.name }));
      break;
    case 'secret':
      await c.secrets.send(new DeleteSecretCommand({ SecretId: r.name, ForceDeleteWithoutRecovery: true }));
      break;
    case 'log-group':
      await c.logs.send(new DeleteLogGroupCommand({ logGroupName: r.name }));
      break;
    case 'event-rule':
    case 'scheduler': {
      const bus = r.extra?.bus;
      const targets = await c.events.send(new ListTargetsByRuleCommand({ Rule: r.name, EventBusName: bus })).catch(() => undefined);
      if (targets?.Targets?.length) await c.events.send(new RemoveTargetsCommand({ Rule: r.name, EventBusName: bus, Ids: targets.Targets.map((t) => t.Id!) }));
      await c.events.send(new DeleteRuleCommand({ Name: r.name, EventBusName: bus, Force: true }));
      break;
    }
    case 'apigateway':
      if (r.id) await c.apigw.send(new DeleteRestApiCommand({ restApiId: r.id }));
      break;
    case 'apigatewayv2':
      if (r.id) await c.apigw2.send(new DeleteApiCommand({ ApiId: r.id }));
      break;
    case 'sfn':
      if (r.arn) await c.sfn.send(new DeleteStateMachineCommand({ stateMachineArn: r.arn }));
      break;
    case 'ecs-service': {
      const cluster = clusterFrom(r, fallbackCluster);
      await drainService(c, cluster, r.name);
      break;
    }
    case 'ecs-cluster':
      await drainCluster(c, r.name);
      break;
    case 'ecr':
      await c.ecr.send(new DeleteRepositoryCommand({ repositoryName: r.name, force: true }));
      break;
    case 'listener':
      if (r.arn) await c.elbv2.send(new DeleteListenerCommand({ ListenerArn: r.arn }));
      break;
    case 'alb':
      if (r.arn) {
        const ls = await c.elbv2.send(new DescribeListenersCommand({ LoadBalancerArn: r.arn })).catch(() => undefined);
        for (const l of ls?.Listeners ?? []) if (l.ListenerArn) await c.elbv2.send(new DeleteListenerCommand({ ListenerArn: l.ListenerArn })).catch(() => undefined);
        await c.elbv2.send(new DeleteLoadBalancerCommand({ LoadBalancerArn: r.arn }));
      }
      break;
    case 'target-group':
      if (r.arn) await c.elbv2.send(new DeleteTargetGroupCommand({ TargetGroupArn: r.arn }));
      break;
    default:
      break;
  }
}

export function clusterFrom(r: ManifestResource, fallbackCluster?: string): string {
  return r.extra?.cluster || fallbackCluster || r.id || r.name;
}

/** Floci/AWS errors that mean the resource is already gone — treat as success so destroy is idempotent. */
export function isAlreadyGone(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; message?: string };
  const text = `${e.name ?? ''} ${e.Code ?? ''} ${e.message ?? ''}`;
  return /not found|does not exist|ResourceNotFound|ClusterNotFound|ServiceNotFound|Invalid API id|NoSuch|QueueDoesNotExist|EntityAlreadyDeleted|SecretNotFound|Couldn't find|cannot be found/i.test(text);
}

async function drainService(c: DeployClients, cluster: string, service: string) {
  await c.ecs.send(new UpdateServiceCommand({ cluster, service, desiredCount: 0 })).catch(() => undefined);
  const tasks = await c.ecs.send(new ListTasksCommand({ cluster, serviceName: service })).catch(() => undefined);
  for (const t of tasks?.taskArns ?? []) {
    await c.ecs.send(new StopTaskCommand({ cluster, task: t, reason: 'aws-emulator destroy' })).catch(() => undefined);
  }
  await c.ecs.send(new DeleteServiceCommand({ cluster, service, force: true }));
}

async function drainCluster(c: DeployClients, cluster: string) {
  const listed = await c.ecs.send(new ListServicesCommand({ cluster })).catch(() => undefined);
  for (const arn of listed?.serviceArns ?? []) {
    const name = arn.split('/').pop() || arn;
    await drainService(c, cluster, name).catch((e) => {
      if (!isAlreadyGone(e)) throw e;
    });
  }
  const tasks = await c.ecs.send(new ListTasksCommand({ cluster })).catch(() => undefined);
  for (const t of tasks?.taskArns ?? []) {
    await c.ecs.send(new StopTaskCommand({ cluster, task: t, reason: 'aws-emulator destroy' })).catch(() => undefined);
  }
  await c.ecs.send(new DeleteClusterCommand({ cluster }));
}


export async function destroyById(opts: Pick<DeployOptions, 'endpoint' | 'region'>, id: string) {
  const manifest = readManifest(id);
  if (!manifest) throw new Error(`no deployment named ${id}`);
  // Resources live in the region they were deployed to, whatever the current default is.
  const clients = makeClients({ endpoint: opts.endpoint, region: manifest.region || opts.region });
  const result = await destroyManifest(clients, manifest);
  if (!result.failed.length) deleteManifest(id);
  else writeManifest({ ...manifest, updatedAt: new Date().toISOString(), warnings: [...manifest.warnings, ...result.failed.map((f) => `destroy ${f.name}: ${f.error}`)] });
  return result;
}
