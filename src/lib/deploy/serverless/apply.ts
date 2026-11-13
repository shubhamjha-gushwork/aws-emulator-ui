import fs from 'fs';
import {
  CreateFunctionCommand, GetFunctionCommand, UpdateFunctionCodeCommand, UpdateFunctionConfigurationCommand,
  CreateEventSourceMappingCommand, ListEventSourceMappingsCommand, UpdateEventSourceMappingCommand,
  type Runtime,
} from '@aws-sdk/client-lambda';
import { CreateQueueCommand, GetQueueUrlCommand, GetQueueAttributesCommand, SetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { CreateTopicCommand } from '@aws-sdk/client-sns';
import { CreateBucketCommand, HeadBucketCommand, PutBucketNotificationConfigurationCommand } from '@aws-sdk/client-s3';
import { CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { CreateSecretCommand, PutSecretValueCommand, DescribeSecretCommand } from '@aws-sdk/client-secrets-manager';
import { CreateLogGroupCommand } from '@aws-sdk/client-cloudwatch-logs';
import { PutRuleCommand, PutTargetsCommand } from '@aws-sdk/client-eventbridge';
import {
  CreateRestApiCommand, GetRestApisCommand, GetResourcesCommand, CreateResourceCommand,
  PutMethodCommand, PutIntegrationCommand, PutMethodResponseCommand, PutIntegrationResponseCommand,
  CreateDeploymentCommand,
} from '@aws-sdk/client-api-gateway';
import { CreateApiCommand, GetApisCommand, CreateIntegrationCommand, CreateRouteCommand, CreateStageCommand } from '@aws-sdk/client-apigatewayv2';
import { CreateStateMachineCommand, ListStateMachinesCommand, UpdateStateMachineCommand } from '@aws-sdk/client-sfn';
import type { DeployClients } from '../client';
import { resourceTags } from '../client';
import { PLACEHOLDER_VALUE, uiHref, type DeployManifest, type ManifestResource, type Plan } from '../types';
import { collectSecrets } from '../interpolate';
import { buildSecretPayload, fillPlaceholderEnv, type EnvMap } from '../envfile';
import { packageFunction } from './package';
import type { ParsedServerless, SlsFunction } from './parse';
import { planServerless } from './parse';

const ROLE = 'arn:aws:iam::000000000000:role/aws-emulator-ui-role';

export async function applyServerless(
  clients: DeployClients,
  parsed: ParsedServerless,
  opts: { dryRun: boolean; id: string; source: string; fileEnv?: EnvMap },
): Promise<{ plan: Plan; manifest?: DeployManifest }> {
  const plan = planServerless(parsed);
  if (opts.dryRun) return { plan };

  const tags = resourceTags({ id: opts.id, stage: parsed.stage, kind: 'serverless', service: parsed.service, source: opts.source });
  const resources: ManifestResource[] = [];
  const logical: Record<string, { arn?: string; url?: string; name: string; id?: string }> = {};

  // 1. Secrets (filled from a local --env-file when keys match; never from real AWS)
  const fileEnv = opts.fileEnv ?? {};
  const filledFromEnv: string[] = [];
  const stillMissing: { name: string; keys: string[] }[] = [];
  for (const s of collectSecrets(parsed.ctx)) {
    const keys = s.keys.length ? s.keys : ['VALUE'];
    const payload = buildSecretPayload(keys, fileEnv);
    await upsertSecret(clients, s.name, payload.secretString);
    filledFromEnv.push(...payload.filled);
    if (payload.missing.length) stillMissing.push({ name: s.name, keys: payload.missing });
    resources.push({ kind: 'secret', name: s.name, href: uiHref('secret') });
  }

  // 2. CloudFormation-like resources
  for (const [logicalId, r] of Object.entries(parsed.cfnResources)) {
    const rec = await upsertCfn(clients, logicalId, r);
    if (rec) {
      logical[logicalId] = rec;
      resources.push({ kind: rec.kind, name: rec.name, arn: 'arn' in rec ? rec.arn : undefined, url: 'url' in rec ? rec.url : undefined, id: 'id' in rec ? (rec as { id?: string }).id : undefined, href: uiHref(rec.kind) });
    }
  }

  // 3. Lift queues + workers
  for (const q of parsed.liftQueues) {
    const queue = await upsertQueue(clients, q.queueName, q.fifo);
    const dlqName = q.queueName.replace(/\.fifo$/, '') + '-dlq' + (q.fifo ? '.fifo' : '');
    const dlq = await upsertQueue(clients, dlqName, q.fifo);
    await clients.sqs.send(new SetQueueAttributesCommand({
      QueueUrl: queue.url,
      Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: 5 }) },
    })).catch(() => undefined);
    logical[q.name] = queue;
    parsed.ctx.constructs[q.name] = { queueUrl: queue.url, queueArn: queue.arn, dlqArn: dlq.arn, dlqUrl: dlq.url };
    resources.push({ kind: 'sqs', name: q.queueName, arn: queue.arn, url: queue.url, href: uiHref('sqs') });
    if (q.worker.handler) {
      const workerFn: SlsFunction = {
        name: `${q.name}Worker`,
        logicalName: `${q.name}WorkerLambdaFunction`,
        deployedName: `${parsed.service}-${parsed.stage}-${q.name}Worker`,
        handler: q.worker.handler,
        runtime: parsed.runtime,
        timeout: q.worker.timeout,
        memory: q.worker.memorySize,
        environment: { ...parsed.environment, ...q.worker.environment },
        events: [{ sqs: { arn: queue.arn, batchSize: q.batchSize, maximumConcurrency: q.maxConcurrency } }],
      };
      parsed.functions.push(workerFn);
    }
  }

  // 4. Lambdas
  const fnArns: Record<string, string> = {};
  for (const fn of parsed.functions) {
    if (fn.image) {
      plan.warnings.push(`${fn.name}: skipped container-image function`);
      continue;
    }
    let packed;
    try {
      packed = await packageFunction(parsed, fn);
    } catch (e) {
      plan.warnings.push(`${fn.name}: packaging failed (${(e as Error).message})`);
      continue;
    }
    const env = { ...fn.environment };
    fillPlaceholderEnv(env, fileEnv);
    const created = await upsertLambda(clients, {
      name: packed.deployedName,
      runtime: packed.runtime,
      handler: packed.handler,
      zip: fs.readFileSync(packed.zipPath),
      timeout: fn.timeout ?? parsed.timeout ?? 30,
      memory: fn.memory ?? parsed.memory ?? 128,
      env,
      tags,
    });
    fnArns[fn.name] = created.arn;
    fnArns[fn.logicalName] = created.arn;
    logical[fn.logicalName] = { arn: created.arn, name: packed.deployedName };
    resources.push({ kind: 'lambda', name: packed.deployedName, arn: created.arn, href: uiHref('lambda') });
  }

  // 5. Events
  let restApi: { id: string; name: string } | undefined;
  let httpApi: { id: string; name: string } | undefined;
  for (const fn of parsed.functions) {
    const arn = fnArns[fn.name];
    if (!arn) continue;
    for (const ev of fn.events) {
      if (ev.http) {
        restApi ??= await upsertRestApi(clients, `${parsed.service}-${parsed.stage}`);
        await putRestRoute(clients, restApi.id, ev.http.method, ev.http.path, arn);
      }
      if (ev.httpApi) {
        httpApi ??= await upsertHttpApi(clients, `${parsed.service}-${parsed.stage}-http`);
        await putHttpRoute(clients, httpApi.id, ev.httpApi.method, ev.httpApi.path, arn, parsed.stage);
      }
      if (ev.schedule) {
        const rate = typeof ev.schedule === 'string' ? ev.schedule : ev.schedule.rate;
        const rule = `${fn.deployedName}-schedule`;
        await clients.events.send(new PutRuleCommand({ Name: rule, ScheduleExpression: rate, State: 'ENABLED' }));
        await clients.events.send(new PutTargetsCommand({ Rule: rule, Targets: [{ Id: 'fn', Arn: arn }] }));
        resources.push({ kind: 'event-rule', name: rule, href: uiHref('event-rule') });
      }
      if (ev.sqs) {
        const srcArn = resolveArn(ev.sqs.arn, logical);
        if (srcArn && !srcArn.includes('Fn::') && !srcArn.includes('${')) {
          await upsertMapping(clients, arn, srcArn, ev.sqs.batchSize, ev.sqs.maximumConcurrency);
          resources.push({ kind: 'event-source-mapping', name: `${fn.deployedName}`, arn: srcArn, href: uiHref('event-source-mapping') });
        } else {
          plan.warnings.push(`${fn.name}: could not resolve SQS arn ${ev.sqs.arn}`);
        }
      }
      if (ev.s3 && ev.s3.bucket) {
        await upsertBucket(clients, ev.s3.bucket);
        await clients.s3.send(new PutBucketNotificationConfigurationCommand({
          Bucket: ev.s3.bucket,
          NotificationConfiguration: { LambdaFunctionConfigurations: [{ Events: [(ev.s3.event || 's3:ObjectCreated:*') as 's3:ObjectCreated:*'], LambdaFunctionArn: arn }] },
        })).catch((e) => plan.warnings.push(`${fn.name}: S3 notification failed (${(e as Error).message})`));
        resources.push({ kind: 's3', name: ev.s3.bucket, href: uiHref('s3') });
      }
      if (ev.eventBridge) {
        const name = `${fn.deployedName}-eb`;
        const bus = String((ev.eventBridge as { eventBusName?: string }).eventBusName || 'default');
        const pattern = (ev.eventBridge as { pattern?: unknown }).pattern;
        await clients.events.send(new PutRuleCommand({
          Name: name,
          EventBusName: bus,
          EventPattern: pattern ? JSON.stringify(pattern) : undefined,
          State: 'ENABLED',
        }));
        await clients.events.send(new PutTargetsCommand({ Rule: name, EventBusName: bus, Targets: [{ Id: 'fn', Arn: arn }] }));
        resources.push({ kind: 'event-rule', name, href: uiHref('event-rule') });
      }
    }
  }
  if (restApi) {
    await clients.apigw.send(new CreateDeploymentCommand({ restApiId: restApi.id, stageName: parsed.stage }));
    resources.push({ kind: 'apigateway', name: restApi.name, id: restApi.id, href: uiHref('apigateway') });
  }
  if (httpApi) {
    resources.push({ kind: 'apigatewayv2', name: httpApi.name, id: httpApi.id, href: uiHref('apigatewayv2') });
  }

  // 6. Step Functions
  for (const sm of parsed.stepFunctions) {
    const def = rewriteSfn(sm.definition, fnArns, logical);
    const arn = await upsertSfn(clients, sm.name, def);
    resources.push({ kind: 'sfn', name: sm.name, arn, href: uiHref('sfn') });
  }

  if (filledFromEnv.length) {
    plan.warnings.push(`filled ${[...new Set(filledFromEnv)].join(', ')} from local env file`);
  }
  const now = new Date().toISOString();
  const manifest: DeployManifest = {
    id: opts.id,
    kind: 'serverless',
    service: parsed.service,
    stage: parsed.stage,
    region: parsed.region,
    source: parsed.file,
    createdAt: now,
    updatedAt: now,
    resources,
    placeholders: stillMissing,
    warnings: [...plan.warnings, ...plan.unsupported],
  };
  return { plan, manifest };
}

async function upsertSecret(c: DeployClients, name: string, value: string) {
  try {
    await c.secrets.send(new DescribeSecretCommand({ SecretId: name }));
    await c.secrets.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
  } catch {
    await c.secrets.send(new CreateSecretCommand({ Name: name, SecretString: value, Description: 'Placeholder created by aws-emulator deploy. Fill in real values locally. Never sourced from real AWS.' }));
  }
}

async function upsertQueue(c: DeployClients, name: string, fifo?: boolean) {
  const attrs: Record<string, string> = {};
  if (fifo || name.endsWith('.fifo')) {
    attrs.FifoQueue = 'true';
    attrs.ContentBasedDeduplication = 'true';
    if (!name.endsWith('.fifo')) name += '.fifo';
  }
  try {
    const url = (await c.sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
    const arn = (await c.sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }))).Attributes?.QueueArn;
    return { name, url, arn: arn || '', kind: 'sqs' as const };
  } catch {
    const url = (await c.sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attrs }))).QueueUrl!;
    const arn = (await c.sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }))).Attributes?.QueueArn;
    return { name, url, arn: arn || '', kind: 'sqs' as const };
  }
}

async function upsertBucket(c: DeployClients, name: string) {
  try {
    await c.s3.send(new HeadBucketCommand({ Bucket: name }));
  } catch {
    await c.s3.send(new CreateBucketCommand({ Bucket: name }));
  }
  return { name, kind: 's3' as const };
}

async function upsertCfn(c: DeployClients, logicalId: string, r: { Type: string; Properties?: Record<string, unknown> }) {
  const p = r.Properties ?? {};
  switch (r.Type) {
    case 'AWS::SQS::Queue': {
      const name = String(p.QueueName || logicalId);
      const fifo = name.endsWith('.fifo') || p.FifoQueue === true || p.FifoQueue === 'true';
      return { logicalId, ...(await upsertQueue(c, name, fifo)) };
    }
    case 'AWS::S3::Bucket': {
      const name = String(p.BucketName || logicalId.toLowerCase());
      return { logicalId, ...(await upsertBucket(c, name)) };
    }
    case 'AWS::SNS::Topic': {
      const name = String(p.TopicName || logicalId);
      const out = await c.sns.send(new CreateTopicCommand({ Name: name }));
      return { logicalId, name, arn: out.TopicArn || '', kind: 'sns' as const };
    }
    case 'AWS::DynamoDB::Table': {
      const name = String(p.TableName || logicalId);
      try {
        await c.ddb.send(new DescribeTableCommand({ TableName: name }));
      } catch {
        const attrs = (p.AttributeDefinitions as { AttributeName: string; AttributeType: string }[]) || [{ AttributeName: 'id', AttributeType: 'S' }];
        const keys = (p.KeySchema as { AttributeName: string; KeyType: string }[]) || [{ AttributeName: attrs[0].AttributeName, KeyType: 'HASH' }];
        await c.ddb.send(new CreateTableCommand({
          TableName: name,
          AttributeDefinitions: attrs as { AttributeName: string; AttributeType: 'S' | 'N' | 'B' }[],
          KeySchema: keys as { AttributeName: string; KeyType: 'HASH' | 'RANGE' }[],
          BillingMode: (p.BillingMode as 'PAY_PER_REQUEST' | 'PROVISIONED') || 'PAY_PER_REQUEST',
        }));
      }
      return { logicalId, name, kind: 'dynamodb' as const };
    }
    case 'AWS::SecretsManager::Secret': {
      const name = String(p.Name || logicalId);
      await upsertSecret(c, name, String(p.SecretString || JSON.stringify({ VALUE: PLACEHOLDER_VALUE })));
      return { logicalId, name, kind: 'secret' as const };
    }
    case 'AWS::Logs::LogGroup': {
      const name = String(p.LogGroupName || logicalId);
      await c.logs.send(new CreateLogGroupCommand({ logGroupName: name })).catch(() => undefined);
      return { logicalId, name, kind: 'log-group' as const };
    }
    default:
      return undefined;
  }
}

async function upsertLambda(c: DeployClients, p: { name: string; runtime: string; handler: string; zip: Buffer; timeout: number; memory: number; env: Record<string, string>; tags: Record<string, string> }) {
  try {
    const got = await c.lambda.send(new GetFunctionCommand({ FunctionName: p.name }));
    await c.lambda.send(new UpdateFunctionCodeCommand({ FunctionName: p.name, ZipFile: p.zip }));
    await c.lambda.send(new UpdateFunctionConfigurationCommand({
      FunctionName: p.name,
      Runtime: p.runtime as Runtime,
      Handler: p.handler,
      Timeout: p.timeout,
      MemorySize: p.memory,
      Environment: { Variables: p.env },
    })).catch(() => undefined);
    return { arn: got.Configuration?.FunctionArn || '', name: p.name };
  } catch {
    const created = await c.lambda.send(new CreateFunctionCommand({
      FunctionName: p.name,
      Runtime: p.runtime as Runtime,
      Role: ROLE,
      Handler: p.handler,
      Code: { ZipFile: p.zip },
      Timeout: p.timeout,
      MemorySize: p.memory,
      Environment: { Variables: p.env },
      Tags: p.tags,
    }));
    return { arn: created.FunctionArn || '', name: p.name };
  }
}

async function upsertMapping(c: DeployClients, fnArn: string, sourceArn: string, batchSize?: number, maxConcurrency?: number) {
  const existing = await c.lambda.send(new ListEventSourceMappingsCommand({ FunctionName: fnArn, EventSourceArn: sourceArn }));
  if (existing.EventSourceMappings?.[0]?.UUID) {
    await c.lambda.send(new UpdateEventSourceMappingCommand({
      UUID: existing.EventSourceMappings[0].UUID,
      BatchSize: batchSize,
      ScalingConfig: maxConcurrency ? { MaximumConcurrency: maxConcurrency } : undefined,
      Enabled: true,
    })).catch(() => undefined);
    return;
  }
  await c.lambda.send(new CreateEventSourceMappingCommand({
    FunctionName: fnArn,
    EventSourceArn: sourceArn,
    BatchSize: batchSize ?? 1,
    ScalingConfig: maxConcurrency ? { MaximumConcurrency: maxConcurrency } : undefined,
    Enabled: true,
  }));
}

async function upsertRestApi(c: DeployClients, name: string) {
  const list = await c.apigw.send(new GetRestApisCommand({ limit: 500 }));
  const found = list.items?.find((a) => a.name === name);
  if (found?.id) return { id: found.id, name };
  const created = await c.apigw.send(new CreateRestApiCommand({ name, description: 'created by aws-emulator deploy', endpointConfiguration: { types: ['REGIONAL'] } }));
  return { id: created.id!, name };
}

async function putRestRoute(c: DeployClients, apiId: string, method: string, routePath: string, fnArn: string) {
  const resources = await c.apigw.send(new GetResourcesCommand({ restApiId: apiId, limit: 500 }));
  let parent: string | undefined = resources.items?.find((r) => r.path === '/')?.id;
  if (!parent) throw new Error('REST API has no root resource');
  const parts = routePath.split('/').filter(Boolean);
  let pathSoFar = '';
  for (const part of parts) {
    pathSoFar += `/${part}`;
    const existing = (await c.apigw.send(new GetResourcesCommand({ restApiId: apiId, limit: 500 }))).items?.find((r) => r.path === pathSoFar);
    if (existing?.id) {
      parent = existing.id;
      continue;
    }
    const createdRes: { id?: string } = await c.apigw.send(new CreateResourceCommand({ restApiId: apiId, parentId: parent, pathPart: part }));
    parent = createdRes.id!;
  }
  const m = method.toUpperCase();
  const uri = `arn:aws:apigateway:${c.region}:lambda:path/2015-03-31/functions/${fnArn}/invocations`;
  await c.apigw.send(new PutMethodCommand({ restApiId: apiId, resourceId: parent, httpMethod: m, authorizationType: 'NONE' })).catch(() => undefined);
  await c.apigw.send(new PutIntegrationCommand({ restApiId: apiId, resourceId: parent, httpMethod: m, type: 'AWS_PROXY', integrationHttpMethod: 'POST', uri })).catch(() => undefined);
  await c.apigw.send(new PutMethodResponseCommand({ restApiId: apiId, resourceId: parent, httpMethod: m, statusCode: '200' })).catch(() => undefined);
  await c.apigw.send(new PutIntegrationResponseCommand({ restApiId: apiId, resourceId: parent, httpMethod: m, statusCode: '200' })).catch(() => undefined);
}

async function upsertHttpApi(c: DeployClients, name: string) {
  const list = await c.apigw2.send(new GetApisCommand({}));
  const found = list.Items?.find((a) => a.Name === name);
  if (found?.ApiId) return { id: found.ApiId, name };
  const created = await c.apigw2.send(new CreateApiCommand({ Name: name, ProtocolType: 'HTTP', Description: 'created by aws-emulator deploy' }));
  return { id: created.ApiId!, name };
}

async function putHttpRoute(c: DeployClients, apiId: string, method: string, routePath: string, fnArn: string, stage: string) {
  const integ = await c.apigw2.send(new CreateIntegrationCommand({
    ApiId: apiId,
    IntegrationType: 'AWS_PROXY',
    IntegrationUri: fnArn,
    PayloadFormatVersion: '2.0',
  }));
  const key = `${method.toUpperCase()} ${routePath.startsWith('/') ? routePath : `/${routePath}`}`;
  await c.apigw2.send(new CreateRouteCommand({ ApiId: apiId, RouteKey: key, Target: `integrations/${integ.IntegrationId}` })).catch(() => undefined);
  await c.apigw2.send(new CreateStageCommand({ ApiId: apiId, StageName: stage, AutoDeploy: true })).catch(() => undefined);
}

async function upsertSfn(c: DeployClients, name: string, definition: unknown) {
  const def = typeof definition === 'string' ? definition : JSON.stringify(definition);
  const list = await c.sfn.send(new ListStateMachinesCommand({ maxResults: 1000 }));
  const found = list.stateMachines?.find((s) => s.name === name);
  if (found?.stateMachineArn) {
    await c.sfn.send(new UpdateStateMachineCommand({ stateMachineArn: found.stateMachineArn, definition: def }));
    return found.stateMachineArn;
  }
  const created = await c.sfn.send(new CreateStateMachineCommand({ name, definition: def, roleArn: ROLE, type: 'STANDARD' }));
  return created.stateMachineArn || '';
}

function resolveArn(expr: unknown, logical: Record<string, { arn?: string; url?: string; name: string }>): string | undefined {
  if (typeof expr === 'string') {
    const trimmed = expr.trim();
    if (trimmed.startsWith('arn:')) return trimmed;
    const m = trimmed.match(/^([A-Za-z0-9]+)\.(Arn|ARN)$/);
    if (m && logical[m[1]]?.arn) return logical[m[1]].arn;
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || trimmed.startsWith('[')) {
      try { return resolveArn(JSON.parse(trimmed), logical); } catch { /* keep as literal */ }
    }
    // Queue name fallback (e.g. sample-jobs-local)
    for (const rec of Object.values(logical)) {
      if (rec.name === trimmed && rec.arn) return rec.arn;
    }
    return trimmed.startsWith('arn:') ? trimmed : undefined;
  }
  if (expr && typeof expr === 'object') {
    const o = expr as Record<string, unknown>;
    if (typeof o.Ref === 'string' && logical[o.Ref]?.arn) return logical[o.Ref].arn;
    const getAtt = o['Fn::GetAtt'];
    if (typeof getAtt === 'string') {
      const id = getAtt.split('.')[0];
      if (logical[id]?.arn) return logical[id].arn;
    }
    if (Array.isArray(getAtt) && typeof getAtt[0] === 'string' && logical[getAtt[0]]?.arn) return logical[getAtt[0]].arn;
  }
  return undefined;
}

function rewriteSfn(def: unknown, fnArns: Record<string, string>, logical: Record<string, { arn?: string }>): unknown {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      for (const [k, arn] of Object.entries(fnArns)) {
        if (v.includes(k) && (v.includes('LambdaFunction') || v === k)) return arn;
      }
      const m = v.match(/^([A-Za-z0-9]+)\.Arn$/);
      if (m && logical[m[1]]?.arn) return logical[m[1]].arn;
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o['Fn::GetAtt'] && Array.isArray(o['Fn::GetAtt'])) {
        const id = String(o['Fn::GetAtt'][0]);
        return fnArns[id] || logical[id]?.arn || v;
      }
      if (typeof o.Ref === 'string' && (fnArns[o.Ref] || logical[o.Ref]?.arn)) return fnArns[o.Ref] || logical[o.Ref]?.arn;
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(o)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(def);
}

// silence unused import if any
