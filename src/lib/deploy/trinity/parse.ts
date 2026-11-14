import fs from 'fs';
import path from 'path';
import { collectSecrets, createCtx, interpolateTree, promoteSecretsManagerRefs, unreferencedSecrets, type InterpCtx } from '../interpolate';
import { loadYaml } from '../yaml';
import { type Plan, type PlannedResource, type ResourceKind, uiHref } from '../types';
import { noRunDetail, serviceDesiredCount } from '../run-mode';
import { fitGeneratedName } from '../cfn';
import { fitFargateResources } from './fargate';

export type TrinityStackKind = 'HTTPApi' | 'Fargate' | 'ScheduledFargate' | string;

export interface TrinityTask {
  name: string;
  dockerfile?: string;
  dockerTarget?: string;
  handler?: string;
  runtime?: string;
  type?: string;
  appPort?: number;
  healthCheckPath?: string;
  albHealthCheckPath?: string;
  cpu?: number;
  memory?: number;
  desiredCount?: number;
  minCapacity?: number;
  maxCapacity?: number;
  schedule?: string;
  environment?: Record<string, string>;
  clusterName?: string;
  regions?: string[];
  volumeSize?: number;
  /** docker build --build-arg values (buildArgs / dockerBuildArgs as a map or KEY=VALUE list). Never printed. */
  buildArgs?: Record<string, string>;
}

export interface ParsedTrinity {
  name: string;
  file: string;
  root: string;
  stage: string;
  region: string;
  environment: Record<string, string>;
  stacks: { kind: TrinityStackKind; clusterName?: string; tasks: TrinityTask[] }[];
  ctx: InterpCtx;
  warnings: string[];
  unsupported: string[];
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}
function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
function strEnv(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(rec(v))) {
    const s = str(val);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

/**
 * Trinity is an internal wrapper around ECS/Fargate/ALB. The format is not
 * formally documented in the checked-out repos, so this parser follows the
 * shapes observed in trinity.yml / *.trinity.yml files:
 *   name, account, region, environment.{refs,variables}, custom.{stage}, stacks.{HTTPApi|Fargate|ScheduledFargate}
 */
export interface ParseOptions {
  stage: string;
  region: string;
  accountId?: string;
  env?: NodeJS.Dict<string>;
  fileEnv?: NodeJS.Dict<string>;
  regionFromFlag?: boolean;
  /** --fallback-stage: stages tried, in order, when a stage-keyed lookup has no value (default: dev). */
  fallbackStages?: string[];
}

export function parseTrinityFile(file: string, opts: ParseOptions): ParsedTrinity {
  const raw = fs.readFileSync(file, 'utf8');
  const doc = rec(loadYaml(raw, file));
  const root = path.dirname(file);
  // custom.stage is the stage being deployed. Stage-keyed lookups such as ${custom.${custom.stage}.cpu} or
  // ${environment.refs.secrets${custom.stage}.KEY} fall back to --fallback-stage in the variable resolver.
  const custom = rec(doc.custom);
  custom.stage = opts.stage;
  doc.custom = custom;

  const ctx = createCtx({ stage: opts.stage, region: opts.region, accountId: opts.accountId, root: doc, fileBase: root, env: opts.env, fileEnv: opts.fileEnv, fallbackStages: opts.fallbackStages, dialect: 'trinity' });
  if (doc.custom) interpolateTree(doc.custom, ctx);
  const refs = rec(rec(doc.environment).refs);
  interpolateTree(refs, ctx);
  promoteSecretsManagerRefs(refs, ctx);
  interpolateTree(doc, ctx);

  const warnings = [...ctx.warnings];
  for (const name of unreferencedSecrets(ctx)) warnings.push(`secret ${name} is not referenced by any variable for stage ${opts.stage}; not created`);
  const unsupported: string[] = [];
  const name = str(doc.name) || path.basename(root);
  // --region wins; otherwise the file's region, then the default.
  const region = opts.regionFromFlag ? opts.region : str(doc.region) || opts.region;
  const envVars = strEnv(rec(doc.environment).variables);

  const stacks: ParsedTrinity['stacks'] = [];
  for (const [kind, body] of Object.entries(rec(doc.stacks))) {
    const items = Array.isArray(body) ? body : [body];
    for (const item of items) {
      const it = rec(item);
      if (kind === 'ScheduledFargate' || kind === 'Fargate') {
        const clusterName = str(it.clusterName);
        const tasks: TrinityTask[] = [];
        for (const t of Array.isArray(it.tasks) ? it.tasks : []) {
          const task = rec(t);
          tasks.push(taskFrom(task, { envVars, clusterName, regions: arr(task.regions) ?? arr(it.regions) }));
        }
        stacks.push({ kind, clusterName, tasks });
      } else if (kind === 'HTTPApi') {
        stacks.push({ kind, clusterName: str(it.clusterName) || `${str(it.name) || name}-${opts.stage}`, tasks: [taskFrom(it, { envVars, regions: arr(it.regions) })] });
      } else {
        unsupported.push(`stack type ${kind} is not supported`);
        // Only an explicit Dockerfile is enough to run an unknown stack as a plain ECS service.
        if (str(it.dockerfile)) {
          stacks.push({ kind, tasks: [taskFrom(it, { envVars, regions: arr(it.regions) })] });
        }
      }
    }
  }

  return { name, file, root, stage: opts.stage, region, environment: envVars, stacks, ctx, warnings, unsupported };
}

function arr(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return [v];
  return undefined;
}

function taskFrom(task: Record<string, unknown>, base: { envVars: Record<string, string>; clusterName?: string; regions?: string[] }): TrinityTask {
  return {
    name: str(task.name) || 'task',
    dockerfile: str(task.dockerfile),
    dockerTarget: str(task.dockerTarget),
    handler: str(task.handler),
    runtime: str(task.runtime),
    type: str(task.type),
    appPort: num(task.appPort),
    healthCheckPath: str(task.healthCheckPath),
    albHealthCheckPath: str(task.albHealthCheckPath),
    cpu: num(task.cpu),
    memory: num(task.memoryLimitMiB) ?? num(task.memorySize) ?? num(task.memory),
    desiredCount: num(task.desiredCount) ?? num(task.desiredCapacity),
    minCapacity: num(task.minCapacity),
    maxCapacity: num(task.maxCapacity),
    schedule: str(task.schedule),
    environment: { ...base.envVars, ...strEnv(task.environment) },
    clusterName: str(task.clusterName) || base.clusterName,
    regions: arr(task.regions) ?? base.regions,
    volumeSize: num(task.volumeSize),
    buildArgs: buildArgsFrom(task.buildArgs ?? task.dockerBuildArgs),
  };
}

function buildArgsFrom(v: unknown): Record<string, string> | undefined {
  if (Array.isArray(v)) {
    const out: Record<string, string> = {};
    for (const item of v) {
      const s = String(item);
      const eq = s.indexOf('=');
      if (eq > 0) out[s.slice(0, eq)] = s.slice(eq + 1);
    }
    return Object.keys(out).length ? out : undefined;
  }
  const m = strEnv(v);
  return Object.keys(m).length ? m : undefined;
}

function slugName(s: string): string {
  return s.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** Physical names apply creates for a task; shared with the plan so both always agree. */
export function trinityNames(parsedName: string, stage: string, t: TrinityTask) {
  // Generated names are fitted to each service's AWS limit (NAME_RULES); names written in the file are kept.
  const family = fitGeneratedName('taskFamily', `${t.name}-${stage}`);
  const base = slugName(`${t.name}-${stage}`);
  const alb = fitGeneratedName('alb', base);
  return {
    cluster: t.clusterName || fitGeneratedName('ecsCluster', `${parsedName}-${stage}`),
    repo: fitGeneratedName('ecr', `aws-emulator/${stage}/${t.name}`.toLowerCase()),
    family,
    logGroup: `/ecs/${family}`,
    rule: fitGeneratedName('rule', `${family}-schedule`),
    alb,
    targetGroup: fitGeneratedName('targetGroup', slugName(`${base}-tg`)),
    listener: `${alb}:80`,
  };
}

/** Container port: appPort, else 8080 for HTTP services (HTTPApi or a health check), else none. */
export function trinityPort(stackKind: string, t: TrinityTask): number | undefined {
  return t.appPort ?? (t.healthCheckPath || stackKind === 'HTTPApi' ? 8080 : undefined);
}

export function planTrinity(parsed: ParsedTrinity, opts: { noRun?: boolean; desiredCount?: number } = {}): Plan {
  const resources: PlannedResource[] = [];
  const add = (kind: ResourceKind, name: string, detail?: string) => {
    resources.push({ kind, name, action: 'create', detail, href: uiHref(kind, name) });
  };
  for (const s of collectSecrets(parsed.ctx)) add('secret', s.name, s.keys.length ? `keys: ${s.keys.join(', ')}` : 'placeholder');
  const clusters = new Set<string>();
  for (const stack of parsed.stacks) {
    for (const t of stack.tasks) {
      const n = trinityNames(parsed.name, parsed.stage, t);
      if (!clusters.has(n.cluster)) {
        clusters.add(n.cluster);
        add('ecs-cluster', n.cluster, stack.kind);
      }
      add('ecr', n.repo, t.dockerfile ? `build ${t.dockerfile}${t.buildArgs ? ` (build args: ${Object.keys(t.buildArgs).join(', ')})` : ''}` : t.handler ? `generated image from ${t.handler}` : 'image');
      const fitted = fitFargateResources(t.cpu ?? 256, t.memory ?? 512);
      add('ecs-task-definition', n.family, `cpu ${fitted.cpu} / mem ${fitted.memory}${fitted.adjusted ? ` (adjusted from ${t.cpu ?? 256}/${t.memory ?? 512})` : ''}`);
      add('log-group', n.logGroup);
      if (t.schedule) {
        add('scheduler', n.rule, noRunDetail(!!opts.noRun, t.schedule));
      } else {
        add('ecs-service', t.name, `desiredCount ${serviceDesiredCount(!!opts.noRun, opts.desiredCount, t.desiredCount)}`);
        const port = trinityPort(stack.kind, t);
        if (port) {
          add('target-group', n.targetGroup, t.albHealthCheckPath || t.healthCheckPath || '/');
          add('alb', n.alb, `container port ${port}`);
          add('listener', n.listener);
        }
      }
      const multi = t.regions && t.regions.length > 1 ? `${t.name}: multi-region (${t.regions.join(', ')}) — only ${parsed.region} is deployed` : undefined;
      if (multi && !parsed.unsupported.includes(multi)) parsed.unsupported.push(multi);
    }
  }
  const note = 'custom domains, ACM, Route 53, and autoscaling are not created';
  if (!parsed.unsupported.includes(note)) parsed.unsupported.push(note);
  return {
    kind: 'trinity',
    service: parsed.name,
    source: parsed.file,
    stage: parsed.stage,
    region: parsed.region,
    resources,
    placeholders: collectSecrets(parsed.ctx).map((s) => ({ name: s.name, keys: s.keys, defaulted: s.defaulted })),
    warnings: parsed.warnings,
    unsupported: parsed.unsupported,
  };
}
