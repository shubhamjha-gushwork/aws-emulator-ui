import fs from 'fs';
import path from 'path';
import {
  CreateFunctionCommand, GetFunctionCommand, UpdateFunctionCodeCommand, UpdateFunctionConfigurationCommand,
  CreateEventSourceMappingCommand, ListEventSourceMappingsCommand, UpdateEventSourceMappingCommand,
  type Runtime,
} from '@aws-sdk/client-lambda';
import { CreateQueueCommand, GetQueueUrlCommand, GetQueueAttributesCommand, SetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { CreateTopicCommand, ListSubscriptionsByTopicCommand, SubscribeCommand } from '@aws-sdk/client-sns';
import { CreateBucketCommand, HeadBucketCommand, PutBucketNotificationConfigurationCommand } from '@aws-sdk/client-s3';
import { CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { CreateSecretCommand, PutSecretValueCommand, DescribeSecretCommand } from '@aws-sdk/client-secrets-manager';
import { CreateLogGroupCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CreateEventBusCommand, DescribeEventBusCommand, PutRuleCommand, PutTargetsCommand } from '@aws-sdk/client-eventbridge';
import {
  CreateRestApiCommand, GetRestApisCommand, GetResourcesCommand, CreateResourceCommand,
  PutMethodCommand, PutIntegrationCommand, PutMethodResponseCommand, PutIntegrationResponseCommand,
  CreateDeploymentCommand,
} from '@aws-sdk/client-api-gateway';
import { CreateApiCommand, GetApisCommand, CreateIntegrationCommand, CreateRouteCommand, CreateStageCommand, GetRoutesCommand } from '@aws-sdk/client-apigatewayv2';
import { CreateStateMachineCommand, ListStateMachinesCommand, UpdateStateMachineCommand } from '@aws-sdk/client-sfn';
import type { DeployClients } from '../client';
import { resourceTags, rethrowIfDown } from '../client';
import { PLACEHOLDER_VALUE, uiHref, type DeployManifest, type ManifestResource, type Plan } from '../types';
import { collectSecrets, resolveConstructTokens } from '../interpolate';
import { buildSecretPayload, classifyKeys, fillPlaceholderEnv, type EnvMap } from '../envfile';
import { triggerEnabled, triggerState } from '../run-mode';
import { decodeIntrinsic, LIMITS, orderByDependencies, referencedIds, resolveIntrinsic, type LogicalMap, type PseudoParams } from '../cfn';
import { packageFunction } from './package';
import type { ParsedServerless, SlsFunction } from './parse';
import {
  busName, cfnPhysicalName, liftDlqName, normalizeLogical, eventBridgeRuleName, httpRouteKey, invalidLambdaName, invalidQueueName, planServerless, restMethod, scheduleRuleName,
} from './parse';

const ROLE = 'arn:aws:iam::000000000000:role/aws-emulator-ui-role';

export async function applyServerless(
  clients: DeployClients,
  parsed: ParsedServerless,
  opts: { dryRun: boolean; id: string; source: string; fileEnv?: EnvMap; noRun?: boolean; resources?: ManifestResource[]; previous?: ManifestResource[] },
): Promise<{ plan: Plan; manifest?: DeployManifest }> {
  const plan = planServerless(parsed, { noRun: opts.noRun });
  if (opts.dryRun) return { plan };

  const tags = resourceTags({ id: opts.id, stage: parsed.stage, kind: 'serverless', service: parsed.service, source: opts.source });
  // Callers may pass an array that checkpoints every push, so an interrupted deploy can still be destroyed.
  const resources: ManifestResource[] = opts.resources ?? [];
  const logical: LogicalMap = {};
  const pseudo: PseudoParams = { region: clients.region, stackName: `${parsed.service}-${parsed.stage}` };
  const warn = (m: string) => {
    if (!plan.warnings.includes(m)) plan.warnings.push(m);
  };
  const lambdaArn = (name: string) => `arn:aws:lambda:${clients.region}:000000000000:function:${name}`;
  // Functions are referenceable (Ref / GetAtt) before they exist: their names are deterministic.
  for (const fn of parsed.functions) logical[fn.logicalName] = { name: fn.deployedName, arn: lambdaArn(fn.deployedName), kind: 'lambda' };

  // 1. Secrets (filled from a local --env-file when keys match; never from real AWS)
  const fileEnv = opts.fileEnv ?? {};
  const filledFromEnv: string[] = [];
  const stillMissing: { name: string; keys: string[] }[] = [];
  for (const s of collectSecrets(parsed.ctx)) {
    const keys = s.keys.length ? s.keys : ['VALUE'];
    const payload = buildSecretPayload(keys, fileEnv);
    await upsertSecret(clients, s.name, payload.secretString);
    filledFromEnv.push(...payload.filled);
    const classified = classifyKeys(keys, fileEnv, s.defaulted);
    if (classified.missing.length) stillMissing.push({ name: s.name, keys: classified.missing });
    resources.push({ kind: 'secret', name: s.name, href: uiHref('secret') });
  }

  // 2. CloudFormation-like resources
  // Referenced resources first (e.g. a DLQ before the queue whose RedrivePolicy points at it).
  const ordered = orderByDependencies(Object.entries(parsed.cfnResources), (b) => referencedIds(b.Properties));
  for (const [logicalId, r] of ordered) {
    try {
      const rec = await upsertCfn(clients, logicalId, r, logical, pseudo, warn);
      if (rec) {
        logical[logicalId] = rec;
        resources.push({ kind: rec.kind, name: rec.name, arn: rec.arn, url: rec.url, id: rec.id, href: uiHref(rec.kind) });
      }
    } catch (e) {
      rethrowIfDown(e);
      warn(`${logicalId} (${r.Type}) failed: ${(e as Error).message}`);
    }
  }

  // 3. Lift queues + workers
  for (const q of parsed.liftQueues) {
    const bad = invalidQueueName(q.queueName);
    if (bad) {
      warn(bad);
      continue;
    }
    const queue = await upsertQueue(clients, q.queueName, q.fifo);
    const dlqName = liftDlqName(q.queueName, !!q.fifo);
    const dlq = await upsertQueue(clients, dlqName, q.fifo);
    await clients.sqs.send(new SetQueueAttributesCommand({
      QueueUrl: queue.url,
      Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: 5 }) },
    })).catch(() => undefined);
    logical[q.name] = queue;
    parsed.ctx.constructs[q.name] = { queueUrl: queue.url, queueArn: queue.arn, dlqArn: dlq.arn, dlqUrl: dlq.url };
    resources.push({ kind: 'sqs', name: q.queueName, arn: queue.arn, url: queue.url, href: uiHref('sqs') });
    resources.push({ kind: 'sqs', name: dlqName, arn: dlq.arn, url: dlq.url, href: uiHref('sqs') });
    if (q.worker.handler) {
      const workerFn: SlsFunction = {
        name: `${q.name}Worker`,
        logicalName: `${normalizeLogical(`${q.name}Worker`)}LambdaFunction`,
        deployedName: `${parsed.service}-${parsed.stage}-${q.name}Worker`,
        packagePatterns: undefined,
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

  // Lift queue URLs/ARNs are known now; rewrite leftover __CONSTRUCT__ tokens in events and env.
  resolveConstructTokens(parsed.functions, parsed.ctx);
  resolveConstructTokens(parsed.environment, parsed.ctx);
  for (const fn of parsed.functions) {
    if (fn.environment) resolveConstructTokens(fn.environment, parsed.ctx);
    if (fn.environment) resolveEnvIntrinsics(fn.name, fn.environment, logical, pseudo, warn);
  }

  // 4. Lambdas
  const fnArns: Record<string, string> = {};
  for (const fn of parsed.functions) {
    if (fn.image) {
      warn(`${fn.name}: skipped container-image function`);
      continue;
    }
    const badName = invalidLambdaName(fn.deployedName);
    if (badName) {
      warn(badName);
      continue;
    }
    let packed;
    try {
      packed = await packageFunction(parsed, fn);
    } catch (e) {
      warn(`${fn.name}: packaging failed (${(e as Error).message})`);
      continue;
    }
    const env = { ...fn.environment };
    fillPlaceholderEnv(env, fileEnv);
    let created;
    try {
      created = await upsertLambda(clients, {
        name: packed.deployedName,
        runtime: packed.runtime,
        handler: packed.handler,
        zip: fs.readFileSync(packed.zipPath),
        timeout: fn.timeout ?? parsed.timeout ?? 30,
        memory: fn.memory ?? parsed.memory ?? 128,
        env,
        tags,
      });
    } catch (e) {
      rethrowIfDown(e);
      warn(`${fn.name}: Lambda create failed (${(e as Error).message})`);
      continue;
    } finally {
      fs.rmSync(path.dirname(packed.zipPath), { recursive: true, force: true });
    }
    fnArns[fn.name] = created.arn;
    fnArns[fn.logicalName] = created.arn;
    logical[fn.logicalName] = { arn: created.arn, name: packed.deployedName };
    resources.push({ kind: 'lambda', name: packed.deployedName, arn: created.arn, href: uiHref('lambda') });
  }

  // 5. Events — one failing trigger is a warning, never an aborted deploy.
  let restApi: { id: string; name: string } | undefined;
  let httpApi: { id: string; name: string } | undefined;
  const noRun = !!opts.noRun;
  for (const fn of parsed.functions) {
    const arn = fnArns[fn.name];
    if (!arn) continue;
    let sched = 0;
    let eb = 0;
    for (const ev of fn.events) {
      const kind = Object.keys(ev).find((k) => ev[k as keyof typeof ev] !== undefined) ?? 'event';
      try {
        if (ev.http) {
          restApi ??= await upsertRestApi(clients, `${parsed.service}-${parsed.stage}`);
          await putRestRoute(clients, restApi.id, restMethod(ev.http.method), ev.http.path, arn);
        }
        if (ev.httpApi) {
          httpApi ??= await upsertHttpApi(clients, `${parsed.service}-${parsed.stage}-http`);
          await putHttpRoute(clients, httpApi.id, httpRouteKey(ev.httpApi.method, ev.httpApi.path), arn, parsed.stage);
        }
        if (ev.schedule) {
          for (const rate of ev.schedule.rates) {
            const rule = scheduleRuleName(fn.deployedName, sched++);
            const state = noRun || !ev.schedule.enabled ? 'DISABLED' : 'ENABLED';
            await clients.events.send(new PutRuleCommand({ Name: rule, ScheduleExpression: rate, State: state }));
            resources.push({ kind: 'event-rule', name: rule, href: uiHref('event-rule') });
            const input = ev.schedule.input === undefined ? undefined : typeof ev.schedule.input === 'string' ? ev.schedule.input : JSON.stringify(ev.schedule.input);
            await clients.events.send(new PutTargetsCommand({ Rule: rule, Targets: [{ Id: 'fn', Arn: arn, Input: input }] }));
          }
        }
        if (ev.sqs) {
          const srcArn = resolveArn(ev.sqs.arn, logical, pseudo);
          if (srcArn && !srcArn.includes('Fn::') && !srcArn.includes('${')) {
            await upsertMapping(clients, arn, srcArn, ev.sqs.batchSize, ev.sqs.maximumConcurrency, noRun || ev.sqs.enabled === false);
            resources.push({ kind: 'event-source-mapping', name: `${fn.deployedName}`, arn: srcArn, extra: { function: fn.deployedName }, href: uiHref('event-source-mapping') });
          } else {
            warn(`${fn.name}: could not resolve SQS arn ${typeof ev.sqs.arn === 'string' ? ev.sqs.arn : JSON.stringify(ev.sqs.arn)}`);
          }
        }
        if (ev.s3 && ev.s3.bucket) {
          await upsertBucket(clients, ev.s3.bucket);
          resources.push({ kind: 's3', name: ev.s3.bucket, href: uiHref('s3') });
          if (noRun) {
            warn(`${fn.name}: S3 notification on ${ev.s3.bucket} skipped (--no-run)`);
          } else {
            await clients.s3.send(new PutBucketNotificationConfigurationCommand({
              Bucket: ev.s3.bucket,
              NotificationConfiguration: { LambdaFunctionConfigurations: [{ Events: [(ev.s3.event || 's3:ObjectCreated:*') as 's3:ObjectCreated:*'], LambdaFunctionArn: arn }] },
            })).catch((e) => warn(`${fn.name}: S3 notification failed (${(e as Error).message})`));
          }
        }
        if (ev.eventBridge) {
          const name = eventBridgeRuleName(fn.deployedName, eb++);
          const bus = busName(ev.eventBridge);
          if (bus !== 'default') {
            const created = await ensureEventBus(clients, bus);
            // Record buses we made now or on an earlier deploy; never claim a pre-existing bus.
            const ours = created || (opts.previous ?? []).some((r) => r.kind === 'event-bus' && r.name === bus);
            if (ours) resources.push({ kind: 'event-bus', name: bus, href: uiHref('event-bus') });
          }
          const pattern = (ev.eventBridge as { pattern?: unknown }).pattern;
          const schedule = (ev.eventBridge as { schedule?: unknown }).schedule;
          if (!pattern && !schedule) {
            warn(`${fn.name}: eventBridge event needs a pattern or schedule; skipped`);
          } else {
            await clients.events.send(new PutRuleCommand({
              Name: name,
              EventBusName: bus,
              EventPattern: pattern ? JSON.stringify(pattern) : undefined,
              ScheduleExpression: schedule ? String(schedule) : undefined,
              State: triggerState(noRun),
            }));
            resources.push({ kind: 'event-rule', name, extra: bus !== 'default' ? { bus } : undefined, href: uiHref('event-rule') });
            await clients.events.send(new PutTargetsCommand({ Rule: name, EventBusName: bus, Targets: [{ Id: 'fn', Arn: arn }] }));
          }
        }
        if (ev.sns) {
          const fromStack = ev.sns.arn !== undefined ? resolveIntrinsic(ev.sns.arn, logical, pseudo) : undefined;
          const stackTopic = typeof fromStack === 'string' && Object.values(logical).some((r) => r.kind === 'sns' && r.arn === fromStack) ? fromStack : undefined;
          let topicArn = stackTopic;
          if (!topicArn) {
            const topicName = ev.sns.topicName;
            if (!topicName) {
              warn(`${fn.name}: SNS event without a topic name or a topic from this stack; skipped`);
            } else {
              const out = await clients.sns.send(new CreateTopicCommand({ Name: topicName }));
              topicArn = out.TopicArn;
              resources.push({ kind: 'sns', name: topicName, arn: topicArn, href: uiHref('sns') });
            }
          }
          if (topicArn) {
            if (noRun) warn(`${fn.name}: SNS subscription skipped (--no-run)`);
            else await subscribeLambda(clients, topicArn, arn, ev.sns.filterPolicy);
          }
        }
      } catch (e) {
        rethrowIfDown(e);
        warn(`${fn.name}: ${kind} event failed (${(e as Error).message})`);
      }
    }
  }
  if (restApi) {
    await clients.apigw.send(new CreateDeploymentCommand({ restApiId: restApi.id, stageName: parsed.stage })).catch((e) => warn(`REST API deployment failed (${(e as Error).message})`));
    resources.push({ kind: 'apigateway', name: restApi.name, id: restApi.id, href: uiHref('apigateway') });
  }
  if (httpApi) {
    resources.push({ kind: 'apigatewayv2', name: httpApi.name, id: httpApi.id, href: uiHref('apigatewayv2') });
  }

  // 6. Step Functions
  for (const sm of parsed.stepFunctions) {
    if (sm.name.length > LIMITS.sfn) continue; // reported by the plan
    try {
      const def = rewriteSfn(sm.definition, fnArns, logical);
      const arn = await upsertSfn(clients, sm.name, def);
      resources.push({ kind: 'sfn', name: sm.name, arn, href: uiHref('sfn') });
    } catch (e) {
      rethrowIfDown(e);
      warn(`state machine ${sm.name} failed (${(e as Error).message})`);
    }
  }

  if (filledFromEnv.length) {
    warn(`filled ${[...new Set(filledFromEnv)].join(', ')} from local env file`);
  }
  const now = new Date().toISOString();
  const manifest: DeployManifest = {
    id: opts.id,
    kind: 'serverless',
    service: parsed.service,
    stage: parsed.stage,
    region: clients.region,
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

async function upsertQueue(c: DeployClients, name: string, fifo?: boolean, extra: Record<string, string> = {}) {
  const attrs: Record<string, string> = { ...extra };
  if (fifo || name.endsWith('.fifo')) {
    attrs.FifoQueue = 'true';
    attrs.ContentBasedDeduplication ??= 'true';
    if (!name.endsWith('.fifo')) name += '.fifo';
  }
  try {
    const url = (await c.sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
    const update = Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== 'FifoQueue'));
    if (Object.keys(update).length) await c.sqs.send(new SetQueueAttributesCommand({ QueueUrl: url, Attributes: update })).catch(() => undefined);
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

const QUEUE_ATTRS = ['DelaySeconds', 'MaximumMessageSize', 'MessageRetentionPeriod', 'ReceiveMessageWaitTimeSeconds', 'VisibilityTimeout', 'ContentBasedDeduplication', 'DeduplicationScope', 'FifoThroughputLimit'];

type CfnRecord = { logicalId: string; name: string; kind: ManifestResource['kind']; arn?: string; url?: string; id?: string };

async function upsertCfn(
  c: DeployClients,
  logicalId: string,
  r: { Type: string; Properties?: Record<string, unknown> },
  logical: LogicalMap,
  pseudo: PseudoParams,
  warn: (m: string) => void,
): Promise<CfnRecord | undefined> {
  const p = r.Properties ?? {};
  let name = cfnPhysicalName(logicalId, r, pseudo, logical);
  if (name === undefined) {
    name = r.Type === 'AWS::S3::Bucket' ? logicalId.toLowerCase() : logicalId;
    warn(`${logicalId}: could not resolve its name locally; using ${name}`);
  }
  const val = (v: unknown) => {
    const out = resolveIntrinsic(v, logical, pseudo);
    return typeof out === 'string' ? out : out === undefined ? undefined : JSON.stringify(out);
  };
  switch (r.Type) {
    case 'AWS::SQS::Queue': {
      const bad = invalidQueueName(name);
      if (bad) {
        warn(bad);
        return undefined;
      }
      const fifo = name.endsWith('.fifo') || p.FifoQueue === true || p.FifoQueue === 'true';
      const attrs: Record<string, string> = {};
      for (const k of QUEUE_ATTRS) {
        if (p[k] === undefined) continue;
        const v = val(p[k]);
        if (v !== undefined) attrs[k] = v;
      }
      if (p.RedrivePolicy !== undefined) {
        const rp = typeof p.RedrivePolicy === 'string' ? safeJson(p.RedrivePolicy) : p.RedrivePolicy;
        const resolved = resolveIntrinsic(rp, logical, pseudo) as { deadLetterTargetArn?: string; maxReceiveCount?: unknown } | undefined;
        if (resolved?.deadLetterTargetArn) attrs.RedrivePolicy = JSON.stringify({ deadLetterTargetArn: resolved.deadLetterTargetArn, maxReceiveCount: Number(resolved.maxReceiveCount ?? 5) });
        else warn(`${logicalId}: RedrivePolicy dead-letter queue could not be resolved; not set`);
      }
      return { logicalId, ...(await upsertQueue(c, name, fifo, attrs)) };
    }
    case 'AWS::S3::Bucket':
      return { logicalId, ...(await upsertBucket(c, name)), arn: `arn:aws:s3:::${name}` };
    case 'AWS::SNS::Topic': {
      const out = await c.sns.send(new CreateTopicCommand({ Name: name }));
      return { logicalId, name, arn: out.TopicArn || '', kind: 'sns' };
    }
    case 'AWS::DynamoDB::Table': {
      try {
        await c.ddb.send(new DescribeTableCommand({ TableName: name }));
      } catch {
        const attrs = (p.AttributeDefinitions as { AttributeName: string; AttributeType: string }[]) || [{ AttributeName: 'id', AttributeType: 'S' }];
        const keys = (p.KeySchema as { AttributeName: string; KeyType: string }[]) || [{ AttributeName: attrs[0].AttributeName, KeyType: 'HASH' }];
        const billing = (p.BillingMode as 'PAY_PER_REQUEST' | 'PROVISIONED') || 'PAY_PER_REQUEST';
        await c.ddb.send(new CreateTableCommand({
          TableName: name,
          AttributeDefinitions: attrs as { AttributeName: string; AttributeType: 'S' | 'N' | 'B' }[],
          KeySchema: keys as { AttributeName: string; KeyType: 'HASH' | 'RANGE' }[],
          BillingMode: billing,
          ProvisionedThroughput: billing === 'PROVISIONED' ? { ReadCapacityUnits: 1, WriteCapacityUnits: 1, ...(p.ProvisionedThroughput as object) } : undefined,
        }));
      }
      return { logicalId, name, kind: 'dynamodb', arn: `arn:aws:dynamodb:${pseudo.region}:000000000000:table/${name}` };
    }
    case 'AWS::SecretsManager::Secret': {
      const secretString = p.SecretString === undefined ? undefined : val(p.SecretString);
      await upsertSecret(c, name, secretString ?? JSON.stringify({ VALUE: PLACEHOLDER_VALUE }));
      return { logicalId, name, kind: 'secret' };
    }
    case 'AWS::Logs::LogGroup': {
      await c.logs.send(new CreateLogGroupCommand({ logGroupName: name })).catch(() => undefined);
      return { logicalId, name, kind: 'log-group', arn: `arn:aws:logs:${pseudo.region}:000000000000:log-group:${name}` };
    }
    default:
      return undefined;
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Replace { Ref } / !GetAtt tokens in Lambda env vars; drop (with a warning) what cannot be resolved locally. */
function resolveEnvIntrinsics(fnName: string, env: Record<string, string>, logical: LogicalMap, pseudo: PseudoParams, warn: (m: string) => void) {
  for (const [k, v] of Object.entries(env)) {
    const decoded = decodeIntrinsic(v);
    if (decoded === undefined) continue;
    const out = resolveIntrinsic(decoded, logical, pseudo);
    if (typeof out === 'string') env[k] = out;
    else {
      delete env[k];
      warn(`${fnName}: env ${k} references something not created locally; left unset`);
    }
  }
}

async function ensureEventBus(c: DeployClients, name: string): Promise<boolean> {
  try {
    await c.events.send(new DescribeEventBusCommand({ Name: name }));
    return false;
  } catch {
    await c.events.send(new CreateEventBusCommand({ Name: name }));
    return true;
  }
}

async function subscribeLambda(c: DeployClients, topicArn: string, fnArn: string, filterPolicy?: unknown) {
  const subs = await c.sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn })).catch(() => undefined);
  if (subs?.Subscriptions?.some((s) => s.Endpoint === fnArn)) return;
  await c.sns.send(new SubscribeCommand({
    TopicArn: topicArn,
    Protocol: 'lambda',
    Endpoint: fnArn,
    Attributes: filterPolicy ? { FilterPolicy: JSON.stringify(filterPolicy) } : undefined,
  }));
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

async function upsertMapping(c: DeployClients, fnArn: string, sourceArn: string, batchSize?: number, maxConcurrency?: number, noRun = false) {
  const enabled = triggerEnabled(noRun);
  const existing = await c.lambda.send(new ListEventSourceMappingsCommand({ FunctionName: fnArn, EventSourceArn: sourceArn }));
  if (existing.EventSourceMappings?.[0]?.UUID) {
    await c.lambda.send(new UpdateEventSourceMappingCommand({
      UUID: existing.EventSourceMappings[0].UUID,
      BatchSize: batchSize,
      ScalingConfig: maxConcurrency ? { MaximumConcurrency: maxConcurrency } : undefined,
      Enabled: enabled,
    })).catch(() => undefined);
    return;
  }
  await c.lambda.send(new CreateEventSourceMappingCommand({
    FunctionName: fnArn,
    EventSourceArn: sourceArn,
    BatchSize: batchSize ?? 1,
    ScalingConfig: maxConcurrency ? { MaximumConcurrency: maxConcurrency } : undefined,
    Enabled: enabled,
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

async function putHttpRoute(c: DeployClients, apiId: string, key: string, fnArn: string, stage: string) {
  const routes = await c.apigw2.send(new GetRoutesCommand({ ApiId: apiId })).catch(() => undefined);
  if (routes?.Items?.some((r) => r.RouteKey === key)) return; // redeploy: route already wired
  const integ = await c.apigw2.send(new CreateIntegrationCommand({
    ApiId: apiId,
    IntegrationType: 'AWS_PROXY',
    IntegrationUri: fnArn,
    PayloadFormatVersion: '2.0',
  }));
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

function resolveArn(expr: unknown, logical: LogicalMap, pseudo: PseudoParams): string | undefined {
  if (expr && typeof expr === 'object') {
    const viaGetAtt = resolveIntrinsic(expr, logical, pseudo);
    if (typeof viaGetAtt === 'string' && viaGetAtt.startsWith('arn:')) return viaGetAtt;
  }
  if (typeof expr === 'string') {
    const trimmed = expr.trim();
    if (trimmed.startsWith('arn:')) return trimmed;
    const m = trimmed.match(/^([A-Za-z0-9]+)\.(Arn|ARN)$/);
    if (m && logical[m[1]]?.arn) return logical[m[1]].arn;
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || trimmed.startsWith('[')) {
      try { return resolveArn(JSON.parse(trimmed), logical, pseudo); } catch { /* keep as literal */ }
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

export function rewriteSfn(def: unknown, fnArns: Record<string, string>, logical: Record<string, { arn?: string }>): unknown {
  const resolveFn = (id: string): string | undefined => fnArns[id] || fnArns[`${id}LambdaFunction`] || logical[id]?.arn || logical[`${id}LambdaFunction`]?.arn;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      // Only rewrite resource-like strings (Name.Arn / NameLambdaFunction). Never rewrite
      // StartAt/Next/Default state names even when they match a function key.
      const att = v.match(/^([A-Za-z0-9_]+)\.(Arn|ARN)$/);
      if (att) {
        const arn = resolveFn(att[1]);
        if (arn) return arn;
      }
      if (v.endsWith('LambdaFunction')) {
        const arn = resolveFn(v) || resolveFn(v.replace(/LambdaFunction$/, ''));
        if (arn) return arn;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o['Fn::GetAtt'] && Array.isArray(o['Fn::GetAtt'])) {
        const id = String(o['Fn::GetAtt'][0]);
        return resolveFn(id) || v;
      }
      if (typeof o.Ref === 'string') {
        const arn = resolveFn(o.Ref);
        if (arn) return arn;
      }
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(o)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(def);
}

