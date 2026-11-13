/**
 * End-to-end user test: drives every service through the UI's own API routes
 * (browser → Next.js route handler → AWS SDK → AWS Emulator) the way a user would, creating, using and
 * deleting throwaway "uitest-*" resources in the region selected in the UI. demo-* seed data is untouched.
 *
 *   npm run build && npm start   # in one terminal (emulator already running)
 *   npm run smoke                # in another; UI_URL defaults to http://127.0.0.1:3297, PREFIX to "uitest"
 */
import { mkdirSync, writeFileSync } from 'fs';

const UI = process.env.UI_URL || 'http://127.0.0.1:3297';
const id = Date.now().toString(36);
const P = `${process.env.PREFIX || 'uitest'}-${id}`;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
/** Poll until fn returns a truthy value (or throw its last error). */
async function until<T>(fn: () => Promise<T>, tries = 20, ms = 500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(ms);
  }
  throw last instanceof Error ? last : new Error('timed out');
}
type Res = { service: string; check: string; ok: boolean; note?: string };
const results: Res[] = [];

async function call<T = unknown>(service: string, action: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(`${UI}/api/aws/${service}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
  const body = (await r.json()) as { data?: T; error?: { name: string; message: string; notImplemented: boolean } };
  if (body.error) throw Object.assign(new Error(`${body.error.name}: ${body.error.message}`), body.error);
  return body.data as T;
}

async function check(service: string, name: string, fn: () => Promise<unknown>, opts: { expectNotImplemented?: boolean } = {}) {
  try {
    const r = await fn();
    if (opts.expectNotImplemented) {
      results.push({ service, check: name, ok: false, note: 'expected NotImplemented but it succeeded (emulator gained support?)' });
      console.log(`  ? ${service.padEnd(12)} ${name} — now implemented`);
    } else {
      results.push({ service, check: name, ok: true });
      console.log(`  ✓ ${service.padEnd(12)} ${name}`);
    }
    return r;
  } catch (e) {
    const err = e as Error & { notImplemented?: boolean };
    if (opts.expectNotImplemented && err.notImplemented) {
      results.push({ service, check: name, ok: true, note: 'NotImplemented in emulator (UI shows "not supported" state)' });
      console.log(`  ✓ ${service.padEnd(12)} ${name} — NotImplemented as expected`);
    } else {
      results.push({ service, check: name, ok: false, note: err.message });
      console.log(`  ✗ ${service.padEnd(12)} ${name} — ${err.message.slice(0, 200)}`);
    }
    return undefined;
  }
}

const must = <T,>(v: T | undefined, what: string): T => {
  if (v === undefined || v === null) throw new Error(`missing ${what}`);
  return v;
};

async function main() {
  console.log(`Smoke testing ${UI} (suffix ${id})`);
  const status = (await (await fetch(`${UI}/api/status`)).json()) as { health: { ok: boolean }; region: string };
  if (!status.health.ok) throw new Error('Emulator not healthy — start it first');
  const region = status.region;
  console.log(`Region ${region}, prefix ${P}`);
  const inRegion = (arn?: string) => { if (arn && arn.split(':')[3] && arn.split(':')[3] !== region) throw new Error(`ARN in wrong region: ${arn}`); };
  const overview = (await (await fetch(`${UI}/api/overview`)).json()) as Record<string, unknown>;
  results.push({ service: 'overview', check: 'counts for 13 services', ok: Object.keys(overview).length === 13 });

  // S3
  const b = P;
  await check('s3', 'create bucket', () => call('s3', 'createBucket', { bucket: b }));
  await check('s3', 'upload object', () => call('s3', 'putObject', { bucket: b, key: 'dir/hello.txt', base64: Buffer.from('hi there').toString('base64'), contentType: 'text/plain' }));
  await check('s3', 'list with prefixes', async () => { const r = await call<{ prefixes: string[] }>('s3', 'listObjects', { bucket: b }); if (!r.prefixes.includes('dir/')) throw new Error('prefix missing'); });
  await check('s3', 'download via route', async () => { const r = await fetch(`${UI}/api/s3/download?bucket=${b}&key=dir/hello.txt`); if ((await r.text()) !== 'hi there') throw new Error('bad body'); });
  await check('s3', 'head object', () => call('s3', 'head', { bucket: b, key: 'dir/hello.txt' }));
  await check('s3', 'empty + delete bucket', async () => { await call('s3', 'emptyBucket', { bucket: b }); await call('s3', 'deleteBucket', { bucket: b }); });

  // SQS
  const q = await check('sqs', 'create queue', () => call<{ QueueUrl: string }>('sqs', 'create', { name: P }));
  const url = (q as { QueueUrl?: string })?.QueueUrl;
  if (url) {
    await check('sqs', 'send', () => call('sqs', 'send', { url, body: '{"n":1}' }));
    const msgs = (await check('sqs', 'receive', () => call<{ ReceiptHandle: string; Body: string }[]>('sqs', 'receive', { url, visibilityTimeout: 30 }))) as { ReceiptHandle: string; Body: string }[] | undefined;
    await check('sqs', 'delete message', () => call('sqs', 'deleteMessage', { url, receiptHandle: must(msgs?.[0]?.ReceiptHandle, 'message') }));
    await check('sqs', 'purge', () => call('sqs', 'purge', { url }));
    await check('sqs', 'delete queue', () => call('sqs', 'delete', { url }));
  }
  await check('sqs', 'create FIFO + send with group', async () => {
    const f = await call<{ QueueUrl: string }>('sqs', 'create', { name: P, fifo: true });
    await call('sqs', 'send', { url: f.QueueUrl, body: 'x', groupId: 'g1' });
    await call('sqs', 'delete', { url: f.QueueUrl });
  });

  // SNS
  const t = (await check('sns', 'create topic', () => call<{ TopicArn: string }>('sns', 'create', { name: P }))) as { TopicArn?: string } | undefined;
  if (t?.TopicArn) {
    const qq = await call<{ QueueUrl: string }>('sqs', 'create', { name: `${P}-sub` });
    const attrs = await call<Record<string, string>>('sqs', 'attributes', { url: qq.QueueUrl });
    const sub = (await check('sns', 'subscribe sqs', () => call<{ SubscriptionArn: string }>('sns', 'subscribe', { arn: t.TopicArn, protocol: 'sqs', endpoint: attrs.QueueArn, grantQueuePolicy: true }))) as { SubscriptionArn?: string } | undefined;
    await check('sns', 'publish', () => call('sns', 'publish', { arn: t.TopicArn, message: 'hello', subject: 's' }));
    await check('sns', 'fan-out reaches SQS', async () => { const m = await call<unknown[]>('sqs', 'receive', { url: qq.QueueUrl, waitSeconds: 2 }); if (!m.length) throw new Error('no message delivered'); });
    await check('sns', 'list subscriptions', () => call('sns', 'subscriptions', { arn: t.TopicArn }));
    if (sub?.SubscriptionArn) await check('sns', 'unsubscribe', () => call('sns', 'unsubscribe', { subscriptionArn: sub.SubscriptionArn }));
    await check('sns', 'delete topic', () => call('sns', 'delete', { arn: t.TopicArn }));
    await call('sqs', 'delete', { url: qq.QueueUrl });
  }

  // Secrets
  const sname = P.replace('-', '/');
  await check('secrets', 'create', () => call('secrets', 'create', { name: sname, value: 'v1' }));
  await check('secrets', 'list hides values', async () => { const l = await call<Record<string, unknown>[]>('secrets', 'list'); if (JSON.stringify(l).includes('"v1"')) throw new Error('value leaked in list'); });
  await check('secrets', 'put new value', () => call('secrets', 'putValue', { id: sname, value: 'v2' }));
  await check('secrets', 'reveal value', async () => { const r = await call<{ value: string }>('secrets', 'getValue', { id: sname }); if (r.value !== 'v2') throw new Error(`got ${r.value}`); });
  await check('secrets', 'describe', () => call('secrets', 'describe', { id: sname }));
  await check('secrets', 'force delete', () => call('secrets', 'delete', { id: sname, force: true }));

  // Logs
  const g = `/${P}`;
  await check('logs', 'create group', () => call('logs', 'createGroup', { name: g }));
  await check('logs', 'put event', () => call('logs', 'putEvent', { group: g, message: 'ERROR boom' }));
  await check('logs', 'streams', () => call('logs', 'streams', { group: g }));
  await check('logs', 'tail events', async () => { const r = await call<{ events: unknown[] }>('logs', 'events', { group: g, stream: 'aws-emulator-ui' }); if (!r.events.length) throw new Error('no events'); });
  await check('logs', 'log group view: filter + stream + time range in one query', async () => {
    await call('logs', 'putEvent', { group: g, message: 'INFO fine' });
    const all = await call<{ events: { message: string }[] }>('logs', 'query', { group: g });
    const errs = await call<{ events: { message: string }[] }>('logs', 'query', { group: g, pattern: 'ERROR', stream: 'aws-emulator-ui', startTime: Date.now() - 15 * 60_000 });
    const none = await call<{ events: unknown[] }>('logs', 'query', { group: g, stream: 'no-such-stream' }).catch(() => ({ events: [] }));
    if (all.events.length < 2 || errs.events.length !== 1 || !errs.events[0].message.includes('ERROR') || none.events.length) throw new Error(JSON.stringify({ all: all.events.length, errs: errs.events.length, none: none.events.length }));
  });
  await check('logs', 'filter events', async () => { const r = await call<unknown[]>('logs', 'filter', { group: g, pattern: 'ERROR' }); if (!r.length) throw new Error('no matches'); });
  await check('logs', 'delete group', () => call('logs', 'deleteGroup', { name: g }));

  // Lambda
  const fn = P;
  await check('lambda', 'create (python3.12)', () => call('lambda', 'create', { name: fn, runtime: 'python3.12' }));
  await check('lambda', 'get', () => call('lambda', 'get', { name: fn }));
  await check('lambda', 'invoke returns payload + log tail', async () => {
    const r = await call<{ statusCode: number; payload: string; logTail: string; functionError?: string }>('lambda', 'invoke', { name: fn, payload: '{"x":42}' });
    if (r.functionError || !r.payload.includes('42') || !r.logTail.includes('START')) throw new Error(JSON.stringify(r).slice(0, 200));
  });
  await check('lambda', 'logs in /aws/lambda/<fn>', () => until(async () => { const l = await call<{ events: { message: string }[] }>('lambda', 'logs', { name: fn }); return l.events.some((e) => e.message.includes('42')); }, 10));
  await check('lambda', 'delete', () => call('lambda', 'delete', { name: fn }));
  await call('logs', 'deleteGroup', { name: `/aws/lambda/${fn}` }).catch(() => undefined);

  // EventBridge + Scheduler
  const bus = P;
  const ebq = await call<{ QueueUrl: string }>('sqs', 'create', { name: `${P}-eb` });
  const ebqArn = (await call<Record<string, string>>('sqs', 'attributes', { url: ebq.QueueUrl })).QueueArn;
  await check('eventbridge', 'create bus', () => call('eventbridge', 'createBus', { name: bus }));
  await check('eventbridge', 'put rule', () => call('eventbridge', 'putRule', { name: `${P}-r`, bus, pattern: '{"source":["smoke"]}' }));
  await check('eventbridge', 'put target', () => call('eventbridge', 'putTarget', { name: `${P}-r`, bus, id: 't1', arn: ebqArn }));
  await check('eventbridge', 'list targets', () => call('eventbridge', 'targets', { name: `${P}-r`, bus }));
  await check('eventbridge', 'put events', () => call('eventbridge', 'putEvents', { bus, source: 'smoke', detailType: 'Ping', detail: '{"a":1}' }));
  await check('eventbridge', 'event delivered to SQS target', () => until(async () => (await call<{ Body: string }[]>('sqs', 'receive', { url: ebq.QueueUrl, waitSeconds: 1 })).some((m) => m.Body.includes('Ping')), 8));
  await check('eventbridge', 'disable rule', () => call('eventbridge', 'setRuleState', { name: `${P}-r`, bus, enabled: false }));
  await check('eventbridge', 'delete rule (removes targets)', () => call('eventbridge', 'deleteRule', { name: `${P}-r`, bus }));
  await check('eventbridge', 'delete bus', () => call('eventbridge', 'deleteBus', { name: bus }));
  await check('scheduler', 'create schedule', () => call('eventbridge', 'createSchedule', { name: `${P}-s`, expression: 'rate(1 day)', targetArn: ebqArn }));
  await check('scheduler', 'get schedule', () => call('eventbridge', 'getSchedule', { name: `${P}-s` }));
  await check('scheduler', 'listed in this region', async () => { const l = await call<{ Name: string; Arn: string }[]>('eventbridge', 'schedules'); if (!l.find((x) => x.Name === `${P}-s`)) throw new Error('not listed'); for (const x of l) inRegion(x.Arn); });
  await check('scheduler', 'delete schedule', () => call('eventbridge', 'deleteSchedule', { name: `${P}-s` }));
  await call('sqs', 'delete', { url: ebq.QueueUrl });

  // Step Functions
  const def = JSON.stringify({ StartAt: 'A', States: { A: { Type: 'Pass', Result: { ok: true }, End: true } } });
  const sm = (await check('stepfunctions', 'create', () => call<{ stateMachineArn: string }>('stepfunctions', 'create', { name: P, definition: def }))) as { stateMachineArn?: string } | undefined;
  if (sm?.stateMachineArn) {
    const ex = (await check('stepfunctions', 'start execution', () => call<{ executionArn: string }>('stepfunctions', 'start', { arn: sm.stateMachineArn, input: '{"x":1}' }))) as { executionArn?: string } | undefined;
    await new Promise((r) => setTimeout(r, 1200));
    if (ex?.executionArn) {
      await check('stepfunctions', 'execution SUCCEEDED', async () => { const d = await call<{ status: string }>('stepfunctions', 'describeExecution', { executionArn: ex.executionArn }); if (d.status !== 'SUCCEEDED') throw new Error(d.status); });
      await check('stepfunctions', 'history', async () => { const h = await call<unknown[]>('stepfunctions', 'history', { executionArn: ex.executionArn }); if (h.length < 2) throw new Error('short history'); });
    }
    await check('stepfunctions', 'list executions', () => call('stepfunctions', 'executions', { arn: sm.stateMachineArn }));
    await check('stepfunctions', 'delete', () => call('stepfunctions', 'delete', { arn: sm.stateMachineArn }));
  }

  // DynamoDB
  const tbl = P;
  await check('dynamodb', 'create table', () => call('dynamodb', 'create', { name: tbl, pk: 'pk', sk: 'sk' }));
  for (let i = 0; i < 20; i++) {
    const d = await call<{ TableStatus: string }>('dynamodb', 'describe', { name: tbl }).catch(() => ({ TableStatus: '' }));
    if (d.TableStatus === 'ACTIVE') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await check('dynamodb', 'put item', () => call('dynamodb', 'putItem', { name: tbl, item: JSON.stringify({ pk: 'a', sk: '1', n: 5, tags: ['x'] }) }));
  await check('dynamodb', 'scan', async () => { const r = await call<{ items: { n: number }[] }>('dynamodb', 'scan', { name: tbl }); if (r.items[0]?.n !== 5) throw new Error(JSON.stringify(r)); });
  await check('dynamodb', 'delete item', () => call('dynamodb', 'deleteItem', { name: tbl, key: JSON.stringify({ pk: 'a', sk: '1' }) }));
  await check('dynamodb', 'delete table', () => call('dynamodb', 'delete', { name: tbl }));

  // ECS: task definition (awslogs) → run task → container output in CloudWatch → service → scale → clean up
  const cl = P;
  type Task = { taskArn: string; lastStatus?: string; stopCode?: string; stoppedReason?: string };
  await check('ecs', 'create cluster', () => call('ecs', 'createCluster', { name: cl }));
  const td = (await check('ecs', 'register task definition (awslogs)', async () => {
    const r = await call<{ taskDefinitionArn: string; containerDefinitions: { logConfiguration?: { options?: Record<string, string> } }[] }>('ecs', 'registerTaskDefinition', { family: P, image: 'public.ecr.aws/docker/library/busybox:latest', port: 80, command: `echo hello-from-${P}` });
    inRegion(r.taskDefinitionArn);
    if (r.containerDefinitions[0].logConfiguration?.options?.['awslogs-group'] !== `/ecs/${P}`) throw new Error('no awslogs config');
    return r;
  })) as { taskDefinitionArn?: string } | undefined;
  const net = await call<{ subnets: { id: string }[] }>('elb', 'network');
  if (td?.taskDefinitionArn) {
    await check('ecs', 'describe task definition', () => call('ecs', 'describeTaskDefinition', { taskDefinition: td.taskDefinitionArn }));
    const run = (await check('ecs', 'run task', async () => {
      const r = await call<{ tasks: Task[]; failures?: unknown[] }>('ecs', 'runTask', { cluster: cl, taskDefinition: td.taskDefinitionArn, subnet: net.subnets[0]?.id });
      if (!r.tasks?.length) throw new Error(JSON.stringify(r.failures));
      inRegion(r.tasks[0].taskArn);
      return r;
    })) as { tasks?: Task[] } | undefined;
    if (run?.tasks?.[0]) {
      const arn = run.tasks[0].taskArn;
      const find = async () => [...(await call<Task[]>('ecs', 'tasks', { cluster: cl })), ...(await call<Task[]>('ecs', 'tasks', { cluster: cl, status: 'STOPPED' }))].find((x) => x.taskArn === arn);
      await check('ecs', 'task starts (RUNNING, no pull error)', () => until(async () => {
        const t = await find();
        if (t?.stopCode === 'TaskFailedToStart') throw new Error(t.stoppedReason);
        return t?.lastStatus === 'RUNNING' || t?.stopCode === 'EssentialContainerExited';
      }, 30));
      await check('ecs', 'container output in /ecs/<family>', () => until(async () => {
        for (const x of await call<{ logStreamName: string }[]>('logs', 'streams', { group: `/ecs/${P}` })) {
          const ev = await call<{ events: { message: string }[] }>('logs', 'events', { group: `/ecs/${P}`, stream: x.logStreamName });
          if (ev.events.some((e) => e.message.includes(`hello-from-${P}`))) return true;
        }
        return false;
      }, 30));
      await check('logs', 'ECS source filter knows the group', async () => { const g = await call<string[]>('logs', 'ecsGroups'); if (!g.includes(`/ecs/${P}`)) throw new Error(JSON.stringify(g)); });
      await check('ecs', 'stopped tasks list shows stop reason', () => until(async () => (await call<Task[]>('ecs', 'tasks', { cluster: cl, status: 'STOPPED' })).some((t) => t.taskArn === arn && !!t.stoppedReason), 30));
    }
    await check('ecs', 'create service', async () => { const r = await call<{ serviceArn: string }>('ecs', 'createService', { cluster: cl, name: 'svc', taskDefinition: td.taskDefinitionArn, desiredCount: 1, subnet: net.subnets[0]?.id }); inRegion(r.serviceArn); });
    await check('ecs', 'service launches a task', () => until(async () => (await call<Task[]>('ecs', 'tasks', { cluster: cl, service: 'svc' })).length + (await call<Task[]>('ecs', 'tasks', { cluster: cl, service: 'svc', status: 'STOPPED' })).length > 0, 20));
    await check('ecs', 'scale service to 0', () => call('ecs', 'scaleService', { cluster: cl, service: 'svc', desiredCount: 0 }));
    await check('ecs', 'delete service', () => call('ecs', 'deleteService', { cluster: cl, service: 'svc' }));
    await check('ecs', 'deregister task definition', () => call('ecs', 'deregisterTaskDefinition', { taskDefinition: td.taskDefinitionArn }));
  }
  await check('ecs', 'delete cluster', async () => {
    for (let i = 0; i < 40; i++) {
      try {
        for (const t of await call<Task[]>('ecs', 'tasks', { cluster: cl })) await call('ecs', 'stopTask', { cluster: cl, task: t.taskArn }).catch(() => undefined);
        return await call('ecs', 'deleteCluster', { cluster: cl });
      } catch (e) {
        if (i === 39) throw e;
        await sleep(500);
      }
    }
  });
  await call('logs', 'deleteGroup', { name: `/ecs/${P}` }).catch(() => undefined);

  // API Gateway
  const rest = (await check('apigateway', 'create REST API', () => call<{ id: string }>('apigateway', 'createRestApi', { name: P }))) as { id?: string } | undefined;
  if (rest?.id) {
    await check('apigateway', 'add MOCK method', () => call('apigateway', 'addMockMethod', { id: rest.id, pathPart: 'ping', method: 'GET' }));
    await check('apigateway', 'resources', () => call('apigateway', 'restResources', { id: rest.id }));
    await check('apigateway', 'deploy stage', () => call('apigateway', 'createDeployment', { id: rest.id, stage: 'dev' }));
    await check('apigateway', 'invoke GET /dev/ping (MOCK) → 200', async () => { const r = await call<{ status: number; body: string }>('apigateway', 'invoke', { id: rest.id, stage: 'dev', method: 'GET', path: '/ping' }); if (r.status !== 200 || !r.body.includes('ok')) throw new Error(`${r.status} ${r.body}`); });
    await check('apigateway', 'stages + deployments', async () => { await call('apigateway', 'restStages', { id: rest.id }); await call('apigateway', 'restDeployments', { id: rest.id }); });
    await check('apigateway', 'delete REST API', () => call('apigateway', 'deleteRestApi', { id: rest.id }));
  }
  const http = (await check('apigatewayv2', 'create HTTP API', () => call<{ ApiId: string }>('apigateway', 'createHttpApi', { name: P }))) as { ApiId?: string } | undefined;
  if (http?.ApiId) {
    const hfn = `${P}-api`;
    await call('lambda', 'create', { name: hfn, runtime: 'nodejs20.x' });
    const hfnArn = (await call<{ configuration: { FunctionArn: string } }>('lambda', 'get', { name: hfn })).configuration.FunctionArn;
    const route = (await check('apigatewayv2', 'create route → Lambda', () => call<{ RouteId: string }>('apigateway', 'createHttpRoute', { id: http.ApiId, routeKey: 'GET /x', lambdaArn: hfnArn }))) as { RouteId?: string } | undefined;
    await check('apigatewayv2', 'create stage', () => call('apigateway', 'createHttpStage', { id: http.ApiId, stage: '$default' }));
    await check('apigatewayv2', 'invoke GET /x → Lambda → 200', async () => { const r = await call<{ status: number; body: string }>('apigateway', 'invoke', { id: http.ApiId, stage: '$default', method: 'GET', path: '/x' }); if (r.status !== 200 || !r.body.includes('ok')) throw new Error(`${r.status} ${r.body.slice(0, 200)}`); });
    await check('apigatewayv2', 'routes/stages/integrations', async () => { await call('apigateway', 'httpRoutes', { id: http.ApiId }); await call('apigateway', 'httpStages', { id: http.ApiId }); await call('apigateway', 'httpIntegrations', { id: http.ApiId }); });
    await check('apigatewayv2', 'export OpenAPI', () => call('apigateway', 'exportHttpApi', { id: http.ApiId }), { expectNotImplemented: true });
    if (route?.RouteId) await check('apigatewayv2', 'delete route', () => call('apigateway', 'deleteHttpRoute', { id: http.ApiId, routeId: route.RouteId }));
    await check('apigatewayv2', 'delete HTTP API', () => call('apigateway', 'deleteHttpApi', { id: http.ApiId }));
    await call('lambda', 'delete', { name: hfn }).catch(() => undefined);
    await call('logs', 'deleteGroup', { name: `/aws/lambda/${hfn}` }).catch(() => undefined);
  }

  // ELBv2
  const vpc = (await call<{ vpcs: { id: string; isDefault?: boolean }[]; subnets: { id: string; vpcId: string; cidr: string }[] }>('elb', 'network'));
  const vpcId = vpc.vpcs.find((v) => v.isDefault)?.id ?? vpc.vpcs[0]?.id;
  const subs = vpc.subnets.filter((s) => s.vpcId === vpcId);
  const tg = (await check('elb', 'create target group', () => call<{ TargetGroupArn: string }>('elb', 'createTargetGroup', { name: P, port: 80, vpcId }))) as { TargetGroupArn?: string } | undefined;
  const lb = (await check('elb', 'create ALB', () => call<{ LoadBalancerArn: string }>('elb', 'createLoadBalancer', { name: P, subnets: subs.slice(0, 2).map((s) => s.id) }))) as { LoadBalancerArn?: string } | undefined;
  if (tg?.TargetGroupArn) {
    await check('elb', 'register target', () => call('elb', 'registerTarget', { targetGroupArn: tg.TargetGroupArn, targetId: subs[0].cidr.split('/')[0].replace(/\.\d+$/, '.50'), port: 80 }));
    await check('elb', 'target health', () => call('elb', 'targetHealth', { targetGroupArn: tg.TargetGroupArn }));
  }
  if (lb?.LoadBalancerArn && tg?.TargetGroupArn) {
    const li = (await check('elb', 'create listener', () => call<{ ListenerArn: string }>('elb', 'createListener', { arn: lb.LoadBalancerArn, port: 8081, targetGroupArn: tg.TargetGroupArn }))) as { ListenerArn?: string } | undefined;
    await check('elb', 'describe listeners', () => call('elb', 'listeners', { arn: lb.LoadBalancerArn }));
    if (li?.ListenerArn) {
      await check('elb', 'describe rules', () => call('elb', 'rules', { listenerArn: li.ListenerArn }));
      await check('elb', 'delete listener', () => call('elb', 'deleteListener', { listenerArn: li.ListenerArn }));
    }
    await check('elb', 'delete ALB', () => call('elb', 'deleteLoadBalancer', { arn: lb.LoadBalancerArn }));
  }
  if (tg?.TargetGroupArn) await check('elb', 'delete target group', () => call('elb', 'deleteTargetGroup', { targetGroupArn: tg.TargetGroupArn }));

  // ECR
  const repo = P.replace('-', '/');
  await check('ecr', 'create repository', () => call('ecr', 'create', { name: repo, scanOnPush: true }));
  await check('ecr', 'list images', () => call('ecr', 'images', { name: repo }));
  await check('ecr', 'auth token', () => call('ecr', 'authToken'));
  await check('ecr', 'images of seeded demo/web', async () => { const i = await call<unknown[]>('ecr', 'images', { name: 'demo/web' }); if (!i.length) throw new Error('no images (run npm run seed)'); });
  await check('ecr', 'delete repository', () => call('ecr', 'delete', { name: repo }));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  mkdirSync('.data', { recursive: true });
  writeFileSync('.data/smoke-results.json', JSON.stringify({ at: new Date().toISOString(), ui: UI, results }, null, 2));
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL ${f.service} ${f.check}: ${f.note}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
