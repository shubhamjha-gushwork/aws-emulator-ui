import fs from 'fs';
import path from 'path';
import { collectSecrets, createCtx, interpolateTree, type InterpCtx } from '../interpolate';
import { loadYaml } from '../yaml';
import { type Plan, type PlannedResource, type ResourceKind, uiHref } from '../types';

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
export function parseTrinityFile(file: string, opts: { stage: string; region: string; accountId?: string }): ParsedTrinity {
  const raw = fs.readFileSync(file, 'utf8');
  const doc = rec(loadYaml(raw));
  const root = path.dirname(file);
  // Inject custom.stage and fall back to custom.dev when custom.<stage> is missing.
  const custom = rec(doc.custom);
  if (custom[opts.stage] === undefined && custom.dev !== undefined) {
    custom[opts.stage] = custom.dev;
  }
  custom.stage = opts.stage;
  doc.custom = custom;

  const ctx = createCtx({ stage: opts.stage, region: opts.region, accountId: opts.accountId, root: doc, fileBase: root });
  interpolateTree(doc, ctx);

  const warnings = [...ctx.warnings];
  const unsupported: string[] = [];
  const name = str(doc.name) || path.basename(root);
  const region = str(doc.region) || opts.region;
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
        // still try to read a dockerfile/name if present
        if (str(it.name) || str(it.dockerfile)) {
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
  };
}

export function planTrinity(parsed: ParsedTrinity): Plan {
  const resources: PlannedResource[] = [];
  const add = (kind: ResourceKind, name: string, detail?: string) => {
    resources.push({ kind, name, action: 'create', detail, href: uiHref(kind, name) });
  };
  for (const s of collectSecrets(parsed.ctx)) add('secret', s.name, s.keys.length ? `keys: ${s.keys.join(', ')}` : 'placeholder');
  for (const stack of parsed.stacks) {
    for (const t of stack.tasks) {
      const cluster = t.clusterName || `${parsed.name}-${parsed.stage}`;
      add('ecs-cluster', cluster, stack.kind);
      add('ecr', `aws-emulator/${parsed.stage}/${t.name}`, t.dockerfile ? `build ${t.dockerfile}` : t.handler ? `generated image from ${t.handler}` : 'image');
      add('ecs-task-definition', `${t.name}-${parsed.stage}`, `cpu ${t.cpu ?? 256} / mem ${t.memory ?? 512}`);
      if (t.schedule) {
        add('scheduler', `${t.name}-${parsed.stage}`, t.schedule);
      } else {
        add('ecs-service', t.name, `desiredCount ${t.desiredCount ?? 1}`);
      }
      if (stack.kind === 'HTTPApi' || t.appPort) {
        add('target-group', `${t.name}-tg`, t.albHealthCheckPath || t.healthCheckPath || '/');
        add('alb', `${t.name}-alb`, `port ${t.appPort ?? 80}`);
        add('listener', `${t.name}-listener`);
      }
      if (t.regions && t.regions.length > 1) parsed.unsupported.push(`${t.name}: multi-region (${t.regions.join(', ')}) — only ${parsed.region} is deployed`);
    }
  }
  parsed.unsupported.push('custom domains, ACM, Route 53, and autoscaling are not created');
  return {
    kind: 'trinity',
    service: parsed.name,
    source: parsed.file,
    stage: parsed.stage,
    region: parsed.region,
    resources,
    placeholders: collectSecrets(parsed.ctx).map((s) => ({ name: s.name, keys: s.keys })),
    warnings: parsed.warnings,
    unsupported: parsed.unsupported,
  };
}
