import { DeleteFunctionCommand } from '@aws-sdk/client-lambda';
import { DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { DeleteTopicCommand } from '@aws-sdk/client-sns';
import { DeleteBucketCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DeleteSecretCommand } from '@aws-sdk/client-secrets-manager';
import { DeleteLogGroupCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DeleteRuleCommand, RemoveTargetsCommand, ListTargetsByRuleCommand } from '@aws-sdk/client-eventbridge';
import { DeleteRestApiCommand } from '@aws-sdk/client-api-gateway';
import { DeleteApiCommand } from '@aws-sdk/client-apigatewayv2';
import { DeleteStateMachineCommand } from '@aws-sdk/client-sfn';
import { DeleteClusterCommand, DeleteServiceCommand, UpdateServiceCommand, ListTasksCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import { DeleteRepositoryCommand } from '@aws-sdk/client-ecr';
import { DeleteLoadBalancerCommand, DeleteTargetGroupCommand, DeleteListenerCommand, DescribeListenersCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import type { DeployClients } from './client';
import { makeClients } from './client';
import { deleteManifest, readManifest, writeManifest } from './state';
import type { DeployManifest, DeployOptions, ManifestResource } from './types';

export async function destroyManifest(clients: DeployClients, manifest: DeployManifest): Promise<{ ok: string[]; failed: { name: string; error: string }[] }> {
  const ok: string[] = [];
  const failed: { name: string; error: string }[] = [];
  const order: ManifestResource['kind'][] = [
    'listener', 'ecs-service', 'scheduler', 'event-rule', 'event-source-mapping',
    'alb', 'target-group', 'lambda', 'sfn', 'apigateway', 'apigatewayv2',
    'ecs-task-definition', 'ecs-cluster', 'ecr', 'sqs', 'sns', 'dynamodb', 's3', 'secret', 'log-group', 'other',
  ];
  const rank = (k: string) => { const i = order.indexOf(k as ManifestResource['kind']); return i < 0 ? 99 : i; };
  const resources = [...manifest.resources].sort((a, b) => rank(a.kind) - rank(b.kind));
  for (const r of resources) {
    try {
      await destroyOne(clients, r);
      ok.push(`${r.kind}:${r.name}`);
    } catch (e) {
      failed.push({ name: `${r.kind}:${r.name}`, error: (e as Error).message });
    }
  }
  return { ok, failed };
}

async function destroyOne(c: DeployClients, r: ManifestResource) {
  switch (r.kind) {
    case 'lambda':
      await c.lambda.send(new DeleteFunctionCommand({ FunctionName: r.name }));
      break;
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
      const targets = await c.events.send(new ListTargetsByRuleCommand({ Rule: r.name })).catch(() => undefined);
      if (targets?.Targets?.length) await c.events.send(new RemoveTargetsCommand({ Rule: r.name, Ids: targets.Targets.map((t) => t.Id!) }));
      await c.events.send(new DeleteRuleCommand({ Name: r.name, Force: true }));
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
      const cluster = clusterFrom(r);
      await c.ecs.send(new UpdateServiceCommand({ cluster, service: r.name, desiredCount: 0 })).catch(() => undefined);
      const tasks = await c.ecs.send(new ListTasksCommand({ cluster, serviceName: r.name })).catch(() => undefined);
      for (const t of tasks?.taskArns ?? []) await c.ecs.send(new StopTaskCommand({ cluster, task: t, reason: 'aws-emulator destroy' })).catch(() => undefined);
      await c.ecs.send(new DeleteServiceCommand({ cluster, service: r.name, force: true }));
      break;
    }
    case 'ecs-cluster':
      await c.ecs.send(new DeleteClusterCommand({ cluster: r.name }));
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

function clusterFrom(r: ManifestResource): string {
  return r.extra?.cluster || r.id || r.name;
}


export async function destroyById(opts: Pick<DeployOptions, 'endpoint' | 'region'>, id: string) {
  const manifest = readManifest(id);
  if (!manifest) throw new Error(`no deployment named ${id}`);
  const clients = makeClients(opts);
  const result = await destroyManifest(clients, manifest);
  if (!result.failed.length) deleteManifest(id);
  else writeManifest({ ...manifest, updatedAt: new Date().toISOString(), warnings: [...manifest.warnings, ...result.failed.map((f) => `destroy ${f.name}: ${f.error}`)] });
  return result;
}
