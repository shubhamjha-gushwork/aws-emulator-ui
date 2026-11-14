import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CreateRepositoryCommand, DescribeRepositoriesCommand, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import {
  CreateClusterCommand, RegisterTaskDefinitionCommand, CreateServiceCommand, UpdateServiceCommand, DescribeServicesCommand,
  type CreateServiceCommandInput, type UpdateServiceCommandInput,
} from '@aws-sdk/client-ecs';
import { CreateLogGroupCommand } from '@aws-sdk/client-cloudwatch-logs';
import {
  CreateLoadBalancerCommand, CreateTargetGroupCommand, CreateListenerCommand,
  DescribeListenersCommand, DescribeLoadBalancersCommand, DescribeTargetGroupsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { DescribeVpcsCommand as DescribeEc2VpcsCommand, DescribeSubnetsCommand as DescribeEc2SubnetsCommand, EC2Client } from '@aws-sdk/client-ec2';
import { PutRuleCommand, PutTargetsCommand } from '@aws-sdk/client-eventbridge';
import type { DeployClients } from '../client';
import { resourceTags } from '../client';
import { upsertPlaceholderSecret } from '../secrets';
import { collectSecrets } from '../interpolate';
import { classifyKeys, fillPlaceholderEnv, type EnvMap } from '../envfile';
import { uiHref, type DeployManifest, type ManifestResource, type Plan } from '../types';
import { planTrinity, trinityNames, trinityPort, type ParsedTrinity, type TrinityTask } from './parse';
import { fitFargateResources } from './fargate';
import { serviceDesiredCount, triggerState } from '../run-mode';

const ROLE = 'arn:aws:iam::000000000000:role/aws-emulator-ui-role';

export async function applyTrinity(
  clients: DeployClients,
  parsed: ParsedTrinity,
  opts: { dryRun: boolean; noBuild: boolean; desiredCount?: number; id: string; source: string; fileEnv?: EnvMap; noRun?: boolean; resources?: ManifestResource[] },
): Promise<{ plan: Plan; manifest?: DeployManifest }> {
  const plan = planTrinity(parsed, { noRun: opts.noRun, desiredCount: opts.desiredCount });
  if (opts.dryRun) return { plan };

  // Fail before creating anything when a build input is missing, so nothing is left half-made.
  if (!opts.noBuild) {
    for (const stack of parsed.stacks) {
      for (const task of stack.tasks) {
        if (task.dockerfile && !fs.existsSync(path.resolve(parsed.root, task.dockerfile))) {
          throw new Error(`${task.name}: Dockerfile not found at ${path.resolve(parsed.root, task.dockerfile)} (fix dockerfile: in ${path.basename(parsed.file)}, or pass --no-build to use an existing image)`);
        }
      }
    }
  }

  const tags = resourceTags({ id: opts.id, stage: parsed.stage, kind: 'trinity', service: parsed.name, source: opts.source });
  const resources: ManifestResource[] = opts.resources ?? [];
  const region = clients.region;

  const fileEnv = opts.fileEnv ?? {};
  const filledFromEnv: string[] = [];
  const stillMissing: { name: string; keys: string[] }[] = [];
  for (const s of collectSecrets(parsed.ctx)) {
    const keys = s.keys.length ? s.keys : ['VALUE'];
    // Merge into an existing secret: shared secrets and hand-filled values survive a redeploy.
    const payload = await upsertPlaceholderSecret(clients, s.name, keys, fileEnv, 'Placeholder created by aws-emulator deploy. Fill in real values locally.');
    filledFromEnv.push(...payload.filled);
    const classified = classifyKeys(keys, fileEnv, s.defaulted);
    const missing = classified.missing.filter((k) => !payload.kept.includes(k));
    if (missing.length) stillMissing.push({ name: s.name, keys: missing });
    resources.push({ kind: 'secret', name: s.name, href: uiHref('secret') });
  }

  const net = await defaultNetwork(clients);

  for (const stack of parsed.stacks) {
    for (const task of stack.tasks) {
      const n = trinityNames(parsed.name, parsed.stage, task);
      const cluster = n.cluster;
      await clients.ecs.send(new CreateClusterCommand({ clusterName: cluster, tags: Object.entries(tags).map(([key, value]) => ({ key, value })) })).catch(() => undefined);
      resources.push({ kind: 'ecs-cluster', name: cluster, href: uiHref('ecs-cluster') });

      const repo = n.repo;
      const image = await ensureImage(clients, parsed, task, repo, opts.noBuild, plan, () => resources.push({ kind: 'ecr', name: repo, href: uiHref('ecr') }));

      const family = n.family;
      const logGroup = n.logGroup;
      await clients.logs.send(new CreateLogGroupCommand({ logGroupName: logGroup })).catch(() => undefined);
      resources.push({ kind: 'log-group', name: logGroup, href: uiHref('log-group', logGroup) });
      const fitted = fitFargateResources(task.cpu ?? 256, task.memory ?? 512);
      if (fitted.adjusted) {
        plan.warnings.push(`${task.name}: Fargate cpu/memory ${task.cpu ?? 256}/${task.memory ?? 512} is not a valid pair; using ${fitted.cpu}/${fitted.memory}`);
      }
      const cpu = String(fitted.cpu);
      const memory = String(fitted.memory);
      const port = trinityPort(stack.kind, task);
      const command = task.handler && !task.dockerfile ? pythonCommand(task) : undefined;
      const td = await clients.ecs.send(new RegisterTaskDefinitionCommand({
        family,
        requiresCompatibilities: ['FARGATE'],
        networkMode: 'awsvpc',
        cpu,
        memory,
        executionRoleArn: ROLE,
        taskRoleArn: ROLE,
        containerDefinitions: [{
          name: task.name,
          image,
          essential: true,
          command,
          environment: Object.entries((() => {
            const env = { ...(task.environment || {}) };
            fillPlaceholderEnv(env, fileEnv);
            return env;
          })()).map(([name, value]) => ({ name, value })),
          portMappings: port ? [{ containerPort: port, protocol: 'tcp' }] : undefined,
          logConfiguration: {
            logDriver: 'awslogs',
            options: { 'awslogs-group': logGroup, 'awslogs-region': region, 'awslogs-stream-prefix': task.name },
          },
        }],
      }));
      const tdArn = td.taskDefinition?.taskDefinitionArn || family;
      resources.push({ kind: 'ecs-task-definition', name: family, arn: tdArn, href: uiHref('ecs-task-definition') });

      if (task.schedule) {
        const rule = n.rule;
        await clients.events.send(new PutRuleCommand({ Name: rule, ScheduleExpression: task.schedule, State: triggerState(!!opts.noRun) }));
        resources.push({ kind: 'scheduler', name: rule, href: uiHref('scheduler') });
        await clients.events.send(new PutTargetsCommand({
          Rule: rule,
          Targets: [{
            Id: 'ecs',
            Arn: `arn:aws:ecs:${region}:000000000000:cluster/${cluster}`,
            RoleArn: ROLE,
            EcsParameters: {
              TaskDefinitionArn: tdArn,
              TaskCount: 1,
              LaunchType: 'FARGATE',
              NetworkConfiguration: { awsvpcConfiguration: { Subnets: net.subnets, AssignPublicIp: 'ENABLED', SecurityGroups: net.sgs } },
            },
          }],
        })).catch((e) => plan.warnings.push(`${task.name}: schedule target failed (${(e as Error).message})`));
      } else {
        const desired = serviceDesiredCount(!!opts.noRun, opts.desiredCount, task.desiredCount);
        const serviceName = task.name;
        let loadBalancers: { targetGroupArn: string; containerName: string; containerPort: number }[] | undefined;
        if (port && net.subnets.length) {
          const alb = await upsertAlb(clients, n, net, port, task.albHealthCheckPath || task.healthCheckPath || '/');
          loadBalancers = [{ targetGroupArn: alb.tgArn, containerName: task.name, containerPort: port }];
          resources.push({ kind: 'alb', name: alb.lbName, arn: alb.lbArn, url: alb.dns, href: uiHref('alb') });
          resources.push({ kind: 'target-group', name: alb.tgName, arn: alb.tgArn, href: uiHref('target-group') });
          if (alb.listenerArn) resources.push({ kind: 'listener', name: n.listener, arn: alb.listenerArn, href: uiHref('listener') });
        } else if (port) {
          plan.warnings.push(`${task.name}: no subnets found in ${region}; load balancer not created`);
        }
        await upsertService(clients, {
          cluster,
          region,
          serviceName,
          update: { cluster, service: serviceName, taskDefinition: tdArn, desiredCount: desired, forceNewDeployment: true },
          create: {
            cluster,
            serviceName,
            taskDefinition: tdArn,
            desiredCount: desired,
            launchType: 'FARGATE',
            networkConfiguration: { awsvpcConfiguration: { subnets: net.subnets, assignPublicIp: 'ENABLED', securityGroups: net.sgs } },
            loadBalancers,
            tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
          },
        });
        resources.push({ kind: 'ecs-service', name: serviceName, extra: { cluster }, href: uiHref('ecs-service') });
      }
    }
  }

  if (filledFromEnv.length) {
    plan.warnings.push(`filled ${[...new Set(filledFromEnv)].join(', ')} from local env file`);
  }
  const now = new Date().toISOString();
  return {
    plan,
    manifest: {
      id: opts.id,
      kind: 'trinity',
      service: parsed.name,
      stage: parsed.stage,
      region,
      source: parsed.file,
      createdAt: now,
      updatedAt: now,
      resources,
      placeholders: stillMissing,
      warnings: [...plan.warnings, ...plan.unsupported],
    },
  };
}

async function ensureImage(c: DeployClients, parsed: ParsedTrinity, task: TrinityTask, repo: string, noBuild: boolean, plan: Plan, onRepo: () => void): Promise<string> {
  await c.ecr.send(new CreateRepositoryCommand({ repositoryName: repo })).catch((e) => {
    if ((e as { name?: string }).name !== 'RepositoryAlreadyExistsException') throw e;
  });
  onRepo();
  const desc = await c.ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [repo] }));
  const uri = desc.repositories?.[0]?.repositoryUri;
  if (!uri) throw new Error(`no repositoryUri for ${repo}`);
  const tag = 'local';
  const ref = `${uri}:${tag}`;
  if (noBuild) {
    plan.warnings.push(`${task.name}: --no-build, expecting ${ref} to already exist (or Floci will pull if the image is public)`);
    return ref;
  }
  const contextDir = buildContext(parsed, task);
  const dockerfile = task.dockerfile
    ? path.resolve(parsed.root, task.dockerfile)
    : path.join(contextDir, 'Dockerfile');
  const args = ['build', '-t', ref, '-f', dockerfile];
  if (task.dockerTarget) args.push('--target', task.dockerTarget);
  // Values go to docker only, never to our output.
  for (const [k, v] of Object.entries(task.buildArgs ?? {})) args.push('--build-arg', `${k}=${v}`);
  args.push(contextDir);
  try {
    execFileSync('docker', args, { stdio: 'inherit' });
  } finally {
    if (!task.dockerfile) fs.rmSync(contextDir, { recursive: true, force: true });
  }
  await dockerLoginAsync(c, uri);
  execFileSync('docker', ['push', ref], { stdio: 'inherit' });
  return ref;
}

function buildContext(parsed: ParsedTrinity, task: TrinityTask): string {
  if (task.dockerfile) return parsed.root;
  // ScheduledFargate python handler: generate a slim image with just the handler.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-emulator-trinity-'));
  const runtime = (task.runtime || 'python3.12').replace('python', '');
  const handler = task.handler || 'app.py';
  const src = path.resolve(parsed.root, handler);
  const destDir = path.join(dir, path.dirname(handler));
  fs.mkdirSync(destDir, { recursive: true });
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, handler));
  else fs.writeFileSync(path.join(dir, handler), 'print("no handler found")\n');
  const req = path.join(parsed.root, 'requirements.txt');
  if (fs.existsSync(req)) fs.copyFileSync(req, path.join(dir, 'requirements.txt'));
  const py = runtime || '3.12';
  fs.writeFileSync(path.join(dir, 'Dockerfile'), `FROM python:${py}-slim\nWORKDIR /app\nCOPY . .\n${fs.existsSync(path.join(dir, 'requirements.txt')) ? 'RUN pip install --no-cache-dir -r requirements.txt || true\n' : ''}CMD ["python", "${handler}"]\n`);
  return dir;
}

function pythonCommand(task: TrinityTask): string[] | undefined {
  if (!task.handler) return undefined;
  return ['python', task.handler];
}

async function dockerLoginAsync(c: DeployClients, uri: string) {
  const auth = await c.ecr.send(new GetAuthorizationTokenCommand({}));
  const data = auth.authorizationData?.[0];
  if (!data?.authorizationToken) throw new Error('GetAuthorizationToken returned no token');
  const decoded = Buffer.from(data.authorizationToken, 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  const user = sep >= 0 ? decoded.slice(0, sep) : 'AWS';
  const password = sep >= 0 ? decoded.slice(sep + 1) : decoded;
  const host = uri.split('/')[0];
  execFileSync('docker', ['login', '--username', user, '--password-stdin', host], { input: password, stdio: ['pipe', 'inherit', 'inherit'] });
}

async function defaultNetwork(c: DeployClients): Promise<{ subnets: string[]; sgs: string[] }> {
  try {
    const ec2 = new EC2Client({ endpoint: c.endpoint, region: c.region, credentials: c.credentials, requestHandler: c.requestHandler, maxAttempts: 1 });
    const vpcs = await ec2.send(new DescribeEc2VpcsCommand({}));
    const vpc = vpcs.Vpcs?.[0]?.VpcId;
    const subs = await ec2.send(new DescribeEc2SubnetsCommand(vpc ? { Filters: [{ Name: 'vpc-id', Values: [vpc] }] } : {}));
    const subnets = (subs.Subnets ?? []).map((s) => s.SubnetId!).filter(Boolean).slice(0, 2);
    return { subnets, sgs: [] };
  } catch {
    return { subnets: [], sgs: [] };
  }
}

async function upsertAlb(
  c: DeployClients,
  names: { alb: string; targetGroup: string },
  net: { subnets: string[]; sgs: string[] },
  port: number,
  healthPath: string,
) {
  const lbName = names.alb;
  const tgName = names.targetGroup;
  let lbArn: string | undefined;
  let dns: string | undefined;
  try {
    const existing = await c.elbv2.send(new DescribeLoadBalancersCommand({ Names: [lbName] }));
    lbArn = existing.LoadBalancers?.[0]?.LoadBalancerArn;
    dns = existing.LoadBalancers?.[0]?.DNSName;
  } catch { /* create */ }
  if (!lbArn) {
    const created = await c.elbv2.send(new CreateLoadBalancerCommand({
      Name: lbName,
      Type: 'application',
      Scheme: 'internal',
      Subnets: net.subnets.length ? net.subnets : undefined,
    }));
    lbArn = created.LoadBalancers?.[0]?.LoadBalancerArn;
    dns = created.LoadBalancers?.[0]?.DNSName;
  }
  let tgArn: string | undefined;
  try {
    const existing = await c.elbv2.send(new DescribeTargetGroupsCommand({ Names: [tgName] }));
    tgArn = existing.TargetGroups?.[0]?.TargetGroupArn;
  } catch { /* create */ }
  if (!tgArn) {
    const created = await c.elbv2.send(new CreateTargetGroupCommand({
      Name: tgName,
      Protocol: 'HTTP',
      Port: port,
      TargetType: 'ip',
      HealthCheckEnabled: true,
      HealthCheckPath: healthPath || '/',
    }));
    tgArn = created.TargetGroups?.[0]?.TargetGroupArn;
  }
  let listenerArn: string | undefined;
  if (lbArn && tgArn) {
    const existing = await c.elbv2.send(new DescribeListenersCommand({ LoadBalancerArn: lbArn })).catch(() => undefined);
    listenerArn = existing?.Listeners?.find((l) => l.Port === 80)?.ListenerArn;
    if (!listenerArn) {
      const created = await c.elbv2.send(new CreateListenerCommand({
        LoadBalancerArn: lbArn,
        Protocol: 'HTTP',
        Port: 80,
        DefaultActions: [{ Type: 'forward', TargetGroupArn: tgArn }],
      })).catch(() => undefined);
      listenerArn = created?.Listeners?.[0]?.ListenerArn;
    }
  }
  return { lbName, lbArn, tgName, tgArn: tgArn || '', dns, listenerArn };
}

/** Parse `arn:<partition>:ecs:<region>:<account>:cluster/<name>`. */
export function parseClusterArn(arn: string): { region: string; cluster: string } | undefined {
  const m = arn.match(/^arn:aws[a-z-]*:ecs:([^:]*):[^:]*:cluster\/(.+)$/);
  return m ? { region: m[1], cluster: m[2] } : undefined;
}

/** A described service counts as present only when it is ACTIVE/DRAINING in the requested cluster and region. */
export function sameServiceHome(s: { serviceName?: string; status?: string; clusterArn?: string }, name: string, cluster: string, region: string): boolean {
  if (s.serviceName !== name || s.status === 'INACTIVE') return false;
  if (!s.clusterArn) return true;
  const home = parseClusterArn(s.clusterArn);
  return !!home && home.cluster === cluster && home.region === region;
}

function errorText(e: unknown): string {
  const err = e as { name?: string; message?: string };
  return `${err?.name ?? ''} ${err?.message ?? ''}`;
}
/** ECS errors meaning "there is no such (active) service here". */
export function isServiceMissing(e: unknown): boolean {
  return /ServiceNotFound|ServiceNotActive|service not found|not active/i.test(errorText(e));
}
/** ECS errors meaning "a service with this name already exists here". */
export function isServiceExisting(e: unknown): boolean {
  return /already exists|idempoten/i.test(errorText(e));
}

/**
 * Create-or-update an ECS service. DescribeServices decides the first attempt, but an emulator may answer
 * it imprecisely (e.g. match a same-named service elsewhere), so the call that fails because the service is
 * missing (or already exists) is retried as the other one once.
 */
export async function upsertService(
  c: Pick<DeployClients, 'ecs'>,
  p: { cluster: string; region: string; serviceName: string; update: UpdateServiceCommandInput; create: CreateServiceCommandInput },
): Promise<'created' | 'updated'> {
  const described = await c.ecs.send(new DescribeServicesCommand({ cluster: p.cluster, services: [p.serviceName] })).catch(() => undefined);
  const present = described?.services?.some((s) => sameServiceHome(s, p.serviceName, p.cluster, p.region)) ?? false;
  const update = async () => { await c.ecs.send(new UpdateServiceCommand(p.update)); return 'updated' as const; };
  const create = async () => { await c.ecs.send(new CreateServiceCommand(p.create)); return 'created' as const; };
  try {
    return present ? await update() : await create();
  } catch (e) {
    if (present && isServiceMissing(e)) return create();
    if (!present && isServiceExisting(e)) return update();
    throw e;
  }
}
