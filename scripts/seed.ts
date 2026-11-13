/**
 * Creates a small set of sample resources in a running AWS Emulator so every page has something to show.
 * Idempotent: "already exists" errors are treated as success.
 *
 *   npm run seed              # uses the UI's saved settings (.data/settings.json) or the defaults
 *   AWS_EMULATOR_ENDPOINT=https://127.0.0.1:9300 npm run seed
 */
import { createHash } from 'crypto';
import { resolveConfig } from '../src/lib/aws';
import { makeCtx } from '../src/lib/services/types';
import { services } from '../src/lib/services';
import { EC2Client, DescribeVpcsCommand, DescribeSubnetsCommand, CreateVpcCommand, CreateSubnetCommand } from '@aws-sdk/client-ec2';
import { IAMClient, CreateRoleCommand, UpdateAssumeRolePolicyCommand } from '@aws-sdk/client-iam';
import { ECRClient, InitiateLayerUploadCommand, UploadLayerPartCommand, CompleteLayerUploadCommand, PutImageCommand } from '@aws-sdk/client-ecr';

const results: { step: string; ok: boolean; note?: string }[] = [];

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const r = await fn();
    results.push({ step: name, ok: true });
    console.log(`  ✓ ${name}`);
    return r;
  } catch (e) {
    const err = e as { name?: string; message?: string };
    const exists = /AlreadyExists|ResourceInUse|ResourceExists|BucketAlreadyOwnedByYou|EntityAlreadyExists|ConflictException|DuplicateLoadBalancerName|DuplicateTargetGroupName|DuplicateListener|ResourceConflict|already exists|not idempotent/i.test(`${err.name} ${err.message}`);
    results.push({ step: name, ok: exists, note: exists ? 'already existed' : `${err.name}: ${err.message}` });
    console.log(`  ${exists ? '✓' : '✗'} ${name}${exists ? ' (already existed)' : ` — ${err.name}: ${err.message?.slice(0, 220)}`}`);
    return undefined;
  }
}

async function main() {
  const cfg = await resolveConfig();
  console.log(`Seeding ${cfg.endpoint} (${cfg.region}, credentials: ${cfg.credentialSource})`);
  const ctx = makeCtx(cfg);
  const a = (svc: string, action: string, p: Record<string, unknown> = {}) => services[svc].actions[action](ctx, p);
  const acct = '000000000000';
  const arn = (svc: string, res: string) => `arn:aws:${svc}:${cfg.region}:${acct}:${res}`;

  console.log('IAM');
  // One role that Lambda, Scheduler, Step Functions and EventBridge may assume (the emulator checks trust, not permissions).
  const trust = JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service: ['lambda.amazonaws.com', 'scheduler.amazonaws.com', 'states.amazonaws.com', 'events.amazonaws.com', 'ecs-tasks.amazonaws.com'] }, Action: 'sts:AssumeRole' }],
  });
  const iam = ctx.client(IAMClient);
  await step('role aws-emulator-ui-role', () => iam.send(new CreateRoleCommand({ RoleName: 'aws-emulator-ui-role', AssumeRolePolicyDocument: trust })));
  await step('role trust policy', () => iam.send(new UpdateAssumeRolePolicyCommand({ RoleName: 'aws-emulator-ui-role', PolicyDocument: trust })));

  console.log('S3');
  await step('bucket demo-assets', () => a('s3', 'createBucket', { bucket: 'demo-assets' }));
  await step('object demo-assets/readme.txt', () => a('s3', 'putObject', { bucket: 'demo-assets', key: 'readme.txt', contentType: 'text/plain', base64: Buffer.from('Hello from AWS Emulator UI\n').toString('base64') }));
  await step('object demo-assets/reports/2026-11.json', () => a('s3', 'putObject', { bucket: 'demo-assets', key: 'reports/2026-11.json', contentType: 'application/json', base64: Buffer.from(JSON.stringify({ leads: 42, month: '2026-11' }, null, 2)).toString('base64') }));
  await step('bucket demo-uploads', () => a('s3', 'createBucket', { bucket: 'demo-uploads' }));

  console.log('SQS');
  await step('queue demo-jobs', () => a('sqs', 'create', { name: 'demo-jobs' }));
  await step('queue demo-jobs-dlq', () => a('sqs', 'create', { name: 'demo-jobs-dlq' }));
  await step('queue demo-events.fifo', () => a('sqs', 'create', { name: 'demo-events', fifo: true }));
  const queues = ((await step('list queues', () => a('sqs', 'list'))) ?? []) as { url: string; name: string; attributes: Record<string, string> }[];
  const jobs = queues.find((q) => q.name === 'demo-jobs');
  if (jobs) {
    for (const i of [1, 2, 3]) await step(`message ${i} → demo-jobs`, () => a('sqs', 'send', { url: jobs.url, body: JSON.stringify({ jobId: i, type: 'crawl', site: `site-${i}.example.com` }) }));
  }
  const jobsArn = jobs?.attributes.QueueArn ?? arn('sqs', 'demo-jobs');

  console.log('SNS');
  const topic = (await step('topic demo-notifications', () => a('sns', 'create', { name: 'demo-notifications' }))) as { TopicArn?: string } | undefined;
  const topicArn = topic?.TopicArn ?? arn('sns', 'demo-notifications');
  await step('subscribe demo-jobs → demo-notifications', () => a('sns', 'subscribe', { arn: topicArn, protocol: 'sqs', endpoint: jobsArn, grantQueuePolicy: true }));
  await step('topic demo-alerts', () => a('sns', 'create', { name: 'demo-alerts' }));

  console.log('Secrets Manager');
  await step('secret demo/db-credentials', () => a('secrets', 'create', { name: 'demo/db-credentials', value: JSON.stringify({ username: 'app', password: 'local-only-not-a-real-password' }), description: 'Sample database credentials' }));
  await step('secret demo/api-key', () => a('secrets', 'create', { name: 'demo/api-key', value: 'sk-local-demo-0000', description: 'Sample API key' }));

  console.log('CloudWatch Logs');
  await step('log group /demo/app', () => a('logs', 'createGroup', { name: '/demo/app' }));
  for (const m of ['service started', 'GET /health 200 3ms', 'processed job 1']) await step(`log event "${m}"`, () => a('logs', 'putEvent', { group: '/demo/app', stream: 'web-1', message: m }));

  console.log('Lambda');
  await step('function demo-hello (nodejs20.x)', () => a('lambda', 'create', { name: 'demo-hello', runtime: 'nodejs20.x' }));
  await step('function demo-py (python3.12)', () => a('lambda', 'create', { name: 'demo-py', runtime: 'python3.12' }));
  await new Promise((r) => setTimeout(r, 1500));
  await step('invoke demo-py', async () => {
    const r = (await a('lambda', 'invoke', { name: 'demo-py', payload: JSON.stringify({ hello: 'world' }) })) as { statusCode?: number; payload: string; functionError?: string };
    if (r.functionError) throw new Error(`function error ${r.functionError}: ${r.payload}`);
    return r;
  });
  await step('invoke demo-hello', async () => {
    const r = (await a('lambda', 'invoke', { name: 'demo-hello', payload: JSON.stringify({ hello: 'node' }) })) as { functionError?: string; payload: string };
    if (r.functionError) throw new Error(`function error ${r.functionError}: ${r.payload}`);
    return r;
  });

  console.log('EventBridge + Scheduler');
  await step('bus demo-bus', () => a('eventbridge', 'createBus', { name: 'demo-bus' }));
  await step('rule demo-order-created (demo-bus)', () => a('eventbridge', 'putRule', { name: 'demo-order-created', bus: 'demo-bus', pattern: JSON.stringify({ source: ['demo.orders'], 'detail-type': ['OrderCreated'] }) }));
  await step('target demo-jobs on demo-order-created', () => a('eventbridge', 'putTarget', { name: 'demo-order-created', bus: 'demo-bus', id: 'jobs-queue', arn: jobsArn }));
  await step('rule demo-nightly (default bus, schedule)', () => a('eventbridge', 'putRule', { name: 'demo-nightly', schedule: 'rate(1 day)' }));
  await step('put event demo.orders/OrderCreated', () => a('eventbridge', 'putEvents', { bus: 'demo-bus', source: 'demo.orders', detailType: 'OrderCreated', detail: JSON.stringify({ orderId: 'o-1001', total: 49.5 }) }));
  await step('schedule demo-hourly-report', () => a('eventbridge', 'createSchedule', { name: 'demo-hourly-report', expression: 'rate(1 hour)', targetArn: jobsArn, input: JSON.stringify({ report: 'hourly' }) }));

  console.log('Step Functions');
  const def = {
    Comment: 'Sample order flow',
    StartAt: 'Validate',
    States: {
      Validate: { Type: 'Pass', Result: { valid: true }, ResultPath: '$.validation', Next: 'IsValid' },
      IsValid: { Type: 'Choice', Choices: [{ Variable: '$.validation.valid', BooleanEquals: true, Next: 'Done' }], Default: 'Rejected' },
      Rejected: { Type: 'Fail', Error: 'Invalid', Cause: 'Order failed validation' },
      Done: { Type: 'Succeed' },
    },
  };
  const sm = (await step('state machine demo-order-flow', () => a('stepfunctions', 'create', { name: 'demo-order-flow', definition: JSON.stringify(def) }))) as { stateMachineArn?: string } | undefined;
  const smArn = sm?.stateMachineArn ?? arn('states', 'stateMachine:demo-order-flow');
  await step('execution of demo-order-flow', () => a('stepfunctions', 'start', { arn: smArn, input: JSON.stringify({ orderId: 'o-1001' }) }));

  console.log('DynamoDB');
  await step('table demo-users', () => a('dynamodb', 'create', { name: 'demo-users', pk: 'id' }));
  await step('table demo-orders', () => a('dynamodb', 'create', { name: 'demo-orders', pk: 'customerId', sk: 'orderId' }));
  for (const t of ['demo-users', 'demo-orders']) {
    await step(`wait for ${t} ACTIVE`, async () => {
      for (let i = 0; i < 40; i++) {
        const d = (await a('dynamodb', 'describe', { name: t })) as { TableStatus?: string };
        if (d?.TableStatus === 'ACTIVE') return;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('table did not become ACTIVE');
    });
  }
  for (const u of [
    { id: 'u-1', name: 'Asha', plan: 'pro', seats: 5 },
    { id: 'u-2', name: 'Ravi', plan: 'starter', seats: 1 },
    { id: 'u-3', name: 'Meera', plan: 'enterprise', seats: 40, tags: ['beta'] },
  ]) await step(`item ${u.id} → demo-users`, () => a('dynamodb', 'putItem', { name: 'demo-users', item: JSON.stringify(u) }));
  await step('item → demo-orders', () => a('dynamodb', 'putItem', { name: 'demo-orders', item: JSON.stringify({ customerId: 'u-1', orderId: 'o-1001', total: 49.5 }) }));

  console.log('EC2 network (for ECS / ELB)');
  const ec2 = ctx.client(EC2Client);
  let vpcId = (await ec2.send(new DescribeVpcsCommand({}))).Vpcs?.[0]?.VpcId;
  if (!vpcId) vpcId = (await step('vpc 10.0.0.0/16', () => ec2.send(new CreateVpcCommand({ CidrBlock: '10.0.0.0/16' }))))?.Vpc?.VpcId;
  const subnetsOf = async (vpc: string) => (await ec2.send(new DescribeSubnetsCommand({ Filters: [{ Name: 'vpc-id', Values: [vpc] }] }))).Subnets ?? [];
  let subnetObjs = await subnetsOf(vpcId!);
  let subnets = subnetObjs.map((s) => s.SubnetId!);
  if (subnets.length < 2 && vpcId) {
    for (const [i, az] of [`${cfg.region}a`, `${cfg.region}b`].entries()) {
      await step(`subnet ${az}`, () => ec2.send(new CreateSubnetCommand({ VpcId: vpcId, CidrBlock: `10.0.${200 + i}.0/24`, AvailabilityZone: az })));
    }
    subnetObjs = await subnetsOf(vpcId);
    subnets = subnetObjs.map((s) => s.SubnetId!);
  }

  console.log('ECS');
  await step('cluster demo-cluster', () => a('ecs', 'createCluster', { name: 'demo-cluster' }));
  const td = (await step('task definition demo-web', () => a('ecs', 'registerTaskDefinition', { family: 'demo-web', image: 'public.ecr.aws/nginx/nginx:latest', port: 80 }))) as { taskDefinitionArn?: string } | undefined;
  if (td?.taskDefinitionArn) {
    await step('service demo-web', () => a('ecs', 'createService', { cluster: 'demo-cluster', name: 'demo-web', taskDefinition: td.taskDefinitionArn, desiredCount: 1, subnet: subnets[0] }));
    await step('run task demo-web', () => a('ecs', 'runTask', { cluster: 'demo-cluster', taskDefinition: td.taskDefinitionArn, subnet: subnets[0] }));
  }

  console.log('Elastic Load Balancing v2');
  const tg = (await step('target group demo-web-tg', () => a('elb', 'createTargetGroup', { name: 'demo-web-tg', port: 80, vpcId }))) as { TargetGroupArn?: string } | undefined;
  const lb = (await step('load balancer demo-alb', () => a('elb', 'createLoadBalancer', { name: 'demo-alb', subnets: subnets.slice(0, 2) }))) as { LoadBalancerArn?: string } | undefined;
  // A target IP inside the first subnet (x.y.z.10).
  const targetIp = (subnetObjs[0]?.CidrBlock ?? '10.0.200.0/24').split('/')[0].replace(/\.\d+$/, '.10');
  if (tg?.TargetGroupArn) await step(`register target ${targetIp}`, () => a('elb', 'registerTarget', { targetGroupArn: tg.TargetGroupArn, targetId: targetIp, port: 80 }));
  if (lb?.LoadBalancerArn && tg?.TargetGroupArn) await step('listener :80 → demo-web-tg', () => a('elb', 'createListener', { arn: lb.LoadBalancerArn, port: 80, targetGroupArn: tg.TargetGroupArn }));

  console.log('API Gateway');
  // API names aren't unique on AWS, so reuse an existing demo API instead of creating duplicates on re-runs.
  const existingRest = ((await a('apigateway', 'restApis')) as { id?: string; name?: string }[]).find((x) => x.name === 'demo-rest-api');
  const rest = existingRest ?? ((await step('REST API demo-rest-api', () => a('apigateway', 'createRestApi', { name: 'demo-rest-api', description: 'Sample REST API' }))) as { id?: string } | undefined);
  if (rest?.id && !existingRest) {
    await step('GET /health (MOCK)', () => a('apigateway', 'addMockMethod', { id: rest.id, pathPart: 'health', method: 'GET' }));
    await step('deploy stage dev', () => a('apigateway', 'createDeployment', { id: rest.id, stage: 'dev' }));
  }
  const existingHttp = ((await a('apigateway', 'httpApis')) as { ApiId?: string; Name?: string }[]).find((x) => x.Name === 'demo-http-api');
  const http = existingHttp ?? ((await step('HTTP API demo-http-api', () => a('apigateway', 'createHttpApi', { name: 'demo-http-api' }))) as { ApiId?: string } | undefined);
  if (http?.ApiId && !existingHttp) {
    await step('route GET /items', () => a('apigateway', 'createHttpRoute', { id: http.ApiId, routeKey: 'GET /items' }));
    await step('route POST /items', () => a('apigateway', 'createHttpRoute', { id: http.ApiId, routeKey: 'POST /items' }));
    await step('stage $default', () => a('apigateway', 'createHttpStage', { id: http.ApiId, stage: '$default' }));
  }

  console.log('ECR');
  await step('repository demo/web', () => a('ecr', 'create', { name: 'demo/web', scanOnPush: true }));
  await step('repository demo/worker', () => a('ecr', 'create', { name: 'demo/worker' }));
  await step('push sample image demo/web:latest', async () => {
    const ecr = ctx.client(ECRClient);
    const repositoryName = 'demo/web';
    const layer = Buffer.from('sample layer contents for aws-emulator-ui');
    const config = Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] } }));
    const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
    for (const blob of [layer, config]) {
      const up = await ecr.send(new InitiateLayerUploadCommand({ repositoryName }));
      await ecr.send(new UploadLayerPartCommand({ repositoryName, uploadId: up.uploadId!, partFirstByte: 0, partLastByte: blob.length - 1, layerPartBlob: blob }));
      await ecr.send(new CompleteLayerUploadCommand({ repositoryName, uploadId: up.uploadId!, layerDigests: [sha(blob)] })).catch((e) => {
        if (e?.name !== 'LayerAlreadyExistsException') throw e;
      });
    }
    const manifest = {
      schemaVersion: 2,
      mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
      config: { mediaType: 'application/vnd.docker.container.image.v1+json', size: config.length, digest: sha(config) },
      layers: [{ mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', size: layer.length, digest: sha(layer) }],
    };
    return ecr.send(new PutImageCommand({ repositoryName, imageManifest: JSON.stringify(manifest), imageTag: 'latest' }));
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nDone: ${results.length - failed.length}/${results.length} steps ok.`);
  if (failed.length) {
    console.log('Failed steps (usually emulator gaps):');
    for (const f of failed) console.log(`  - ${f.step}: ${f.note}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
