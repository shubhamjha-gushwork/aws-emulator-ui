/**
 * Evidence probe: which workloads write to CloudWatch Logs on AWS Emulator by themselves?
 * Uses raw SDK calls for the writes being tested (no UI capture), uitest-* resources, and cleans up.
 *
 *   npm run logs-probe            # region from REGION or us-east-1
 */
import { CloudWatchLogsClient, DescribeLogStreamsCommand, GetLogEventsCommand, DeleteLogGroupCommand } from '@aws-sdk/client-cloudwatch-logs';
import { LambdaClient, CreateFunctionCommand, InvokeCommand, DeleteFunctionCommand, GetFunctionCommand } from '@aws-sdk/client-lambda';
import { IAMClient, CreateRoleCommand, DeleteRoleCommand } from '@aws-sdk/client-iam';
import { ECSClient, CreateClusterCommand, RegisterTaskDefinitionCommand, RunTaskCommand, DescribeTasksCommand, DeleteClusterCommand, DeregisterTaskDefinitionCommand } from '@aws-sdk/client-ecs';
import { resolveConfig } from '../src/lib/aws';
import { DEFAULT_SETTINGS } from '../src/lib/settings';
import { makeCtx } from '../src/lib/services/types';
import { ensureHelperRole } from '../src/lib/services/iam-role';
import { ensureDefaultVpcEgress } from '../src/lib/services/ecs';
import { services } from '../src/lib/services';
import { zipSource } from '../src/lib/services/lambda';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const id = `uitest-probe-${Date.now().toString(36)}`;

async function main() {
  const region = process.env.REGION || 'us-east-1';
  const ctx = makeCtx(await resolveConfig({ ...DEFAULT_SETTINGS, region }));
  const logs = ctx.client(CloudWatchLogsClient);
  const lines = async (group: string) => {
    const out: string[] = [];
    const st = await logs.send(new DescribeLogStreamsCommand({ logGroupName: group })).catch(() => undefined);
    for (const s of st?.logStreams ?? []) out.push(...((await logs.send(new GetLogEventsCommand({ logGroupName: group, logStreamName: s.logStreamName! }))).events ?? []).map((e) => `[${s.logStreamName}] ${e.message}`));
    return st ? out : null;
  };
  console.log(`Region ${region}`);

  // Lambda, two roles: the UI helper role (allows logs:*) and a bare role (no permissions).
  const iam = ctx.client(IAMClient);
  const helper = await ensureHelperRole(ctx);
  const bare = (await iam.send(new CreateRoleCommand({ RoleName: `${id}-bare`, AssumeRolePolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] }) }))).Role!.Arn!;
  const lambda = ctx.client(LambdaClient);
  for (const [label, role] of [['helper role (logs allowed)', helper], ['bare role (no logs permission)', bare]] as const) {
    const fn = `${id}-${role === helper ? 'h' : 'b'}`;
    await lambda.send(new CreateFunctionCommand({ FunctionName: fn, Runtime: 'python3.12', Handler: 'lambda_function.handler', Role: role, Code: { ZipFile: await zipSource('lambda_function.py', "def handler(e, c):\n    print('probe says hi')\n    return 1\n") } }));
    for (let i = 0; i < 40 && (await lambda.send(new GetFunctionCommand({ FunctionName: fn }))).Configuration?.State === 'Pending'; i++) await sleep(250);
    await lambda.send(new InvokeCommand({ FunctionName: fn, Payload: new TextEncoder().encode('{}') }));
    await sleep(1000);
    const l = await lines(`/aws/lambda/${fn}`);
    console.log(`\nLambda with ${label}: /aws/lambda/${fn} → ${l === null ? 'NO log group' : `${l.length} events`}`);
    for (const x of l ?? []) console.log('   ', x);
    await lambda.send(new DeleteFunctionCommand({ FunctionName: fn }));
    await logs.send(new DeleteLogGroupCommand({ logGroupName: `/aws/lambda/${fn}` })).catch(() => undefined);
  }
  await iam.send(new DeleteRoleCommand({ RoleName: `${id}-bare` }));

  // ECS awslogs: shell command and an image without a command.
  const ecs = ctx.client(ECSClient);
  await ecs.send(new CreateClusterCommand({ clusterName: id }));
  const net = (await services.elb.actions.network(ctx, {})) as { subnets: { id: string }[] };
  await ensureDefaultVpcEgress(ctx, net.subnets[0].id);
  await services.logs.actions.createGroup(ctx, { name: `/ecs/${id}` }).catch(() => undefined);
  for (const [label, image, command] of [['busybox + sh -c "echo …"', 'public.ecr.aws/docker/library/busybox:latest', ['sh', '-c', `echo hello-from-${id}; echo second line`]], ['nginx, no command', 'public.ecr.aws/nginx/nginx:latest', undefined]] as const) {
    const td = (await ecs.send(new RegisterTaskDefinitionCommand({ family: id, requiresCompatibilities: ['FARGATE'], networkMode: 'awsvpc', cpu: '256', memory: '512', executionRoleArn: helper,
      containerDefinitions: [{ name: 'app', image, command: command ? [...command] : undefined, essential: true, logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': `/ecs/${id}`, 'awslogs-region': region, 'awslogs-stream-prefix': image.includes('busybox') ? 'sh' : 'nginx' } } }] }))).taskDefinition!;
    const task = (await ecs.send(new RunTaskCommand({ cluster: id, taskDefinition: td.taskDefinitionArn, launchType: 'FARGATE', networkConfiguration: { awsvpcConfiguration: { subnets: [net.subnets[0].id], assignPublicIp: 'ENABLED' } } }))).tasks![0];
    const seen: string[] = [];
    let t = task;
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      t = (await ecs.send(new DescribeTasksCommand({ cluster: id, tasks: [task.taskArn!] }))).tasks![0];
      if (!seen.at(-1)?.startsWith(t.lastStatus!)) seen.push(`${t.lastStatus}@${i + 1}s`);
      if (t.lastStatus === 'STOPPED') break;
    }
    console.log(`\nECS task (${label}): ${seen.join(' → ')}; ${t.stopCode ?? ''} ${t.stoppedReason ?? ''}; exitCode ${t.containers?.[0]?.exitCode ?? '—'}`);
    await ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition: td.taskDefinitionArn }));
  }
  const l = await lines(`/ecs/${id}`);
  console.log(`  /ecs/${id} → ${l?.length ?? 0} events`);
  for (const x of l ?? []) console.log('   ', x);
  await ecs.send(new DeleteClusterCommand({ cluster: id })).catch((e) => console.log('cluster delete:', (e as Error).message));
  await logs.send(new DeleteLogGroupCommand({ logGroupName: `/ecs/${id}` })).catch(() => undefined);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
