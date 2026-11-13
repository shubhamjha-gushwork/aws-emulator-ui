import fs from 'fs';
import path from 'path';
import { collectSecrets, createCtx, interpolateTree, type InterpCtx, type SecretBag } from '../interpolate';
import { loadYaml } from '../yaml';
import { type Plan, type PlannedResource, uiHref, type ResourceKind } from '../types';

export interface SlsHttpEvent {
  method: string;
  path: string;
  cors?: boolean;
  private?: boolean;
  authorizer?: unknown;
}

export interface SlsFunction {
  name: string;
  logicalName: string;
  deployedName: string;
  handler?: string;
  image?: unknown;
  runtime?: string;
  timeout?: number;
  memory?: number;
  environment?: Record<string, string>;
  events: {
    http?: SlsHttpEvent;
    httpApi?: SlsHttpEvent;
    schedule?: string | { rate: string; enabled?: boolean; input?: unknown };
    sqs?: { arn: string | Record<string, unknown>; batchSize?: number; maximumConcurrency?: number };
    s3?: { bucket: string; event?: string; existing?: boolean; rules?: unknown };
    eventBridge?: Record<string, unknown>;
    sns?: unknown;
    other?: string;
  }[];
}

export interface LiftQueue {
  name: string;
  queueName: string;
  fifo?: boolean;
  batchSize?: number;
  maxConcurrency?: number;
  worker: { handler?: string; image?: unknown; timeout?: number; memorySize?: number; environment?: Record<string, string> };
}

export interface ParsedServerless {
  service: string;
  file: string;
  root: string;
  stage: string;
  region: string;
  runtime?: string;
  timeout?: number;
  memory?: number;
  environment: Record<string, string>;
  functions: SlsFunction[];
  liftQueues: LiftQueue[];
  cfnResources: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
  stepFunctions: { name: string; definition: unknown }[];
  packagePatterns?: { include?: string[]; exclude?: string[]; patterns?: string[]; individually?: boolean };
  esbuild?: Record<string, unknown>;
  pythonRequirements?: boolean;
  ctx: InterpCtx;
  warnings: string[];
  unsupported: string[];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function strEnv(env: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(asRecord(env))) {
    const s = asString(v);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

export function parseServerlessFile(file: string, opts: { stage: string; region: string; accountId?: string; env?: NodeJS.Dict<string> }): ParsedServerless {
  const raw = fs.readFileSync(file, 'utf8');
  const doc = asRecord(loadYaml(raw));
  const root = path.dirname(file);
  const ctx = createCtx({ stage: opts.stage, region: opts.region, accountId: opts.accountId, root: doc, fileBase: root, env: opts.env });
  interpolateTree(doc, ctx);

  const warnings = [...ctx.warnings];
  const unsupported: string[] = [];
  const service = asString(doc.service) || path.basename(root);
  const provider = asRecord(doc.provider);
  const custom = asRecord(doc.custom);
  const runtime = asString(provider.runtime);
  const region = asString(provider.region) || opts.region;
  const stage = asString(custom.stage) || opts.stage;

  const plugins = (Array.isArray(doc.plugins) ? doc.plugins : []).map(String);
  for (const p of plugins) {
    if (/domain-manager|global-authorizer|prune|disable-functions/i.test(p)) {
      unsupported.push(`plugin ${p} is ignored (not applied on Floci)`);
    }
  }

  const functions: SlsFunction[] = [];
  for (const [name, def] of Object.entries(asRecord(doc.functions))) {
    const f = asRecord(def);
    const deployedName = asString(f.name) || `${service}-${stage}-${name}`;
    const evs: SlsFunction['events'] = [];
    for (const ev of Array.isArray(f.events) ? f.events : []) {
      if (typeof ev === 'string') {
        evs.push({ other: ev });
        continue;
      }
      const e = asRecord(ev);
      if ('http' in e) evs.push({ http: parseHttp(e.http) });
      else if ('httpApi' in e) evs.push({ httpApi: parseHttp(e.httpApi) });
      else if ('schedule' in e) evs.push({ schedule: e.schedule as SlsFunction['events'][0]['schedule'] });
      else if ('sqs' in e) evs.push({ sqs: parseSqs(e.sqs) });
      else if ('s3' in e) evs.push({ s3: parseS3(e.s3) });
      else if ('eventBridge' in e) evs.push({ eventBridge: asRecord(e.eventBridge) });
      else if ('sns' in e) evs.push({ sns: e.sns });
      else evs.push({ other: Object.keys(e)[0] });
    }
    functions.push({
      name,
      logicalName: `${normalizeLogical(name)}LambdaFunction`,
      deployedName,
      handler: asString(f.handler),
      image: f.image,
      runtime: asString(f.runtime) || runtime,
      timeout: num(f.timeout) ?? num(provider.timeout),
      memory: num(f.memorySize) ?? num(provider.memorySize),
      environment: { ...strEnv(provider.environment), ...strEnv(f.environment) },
      events: evs,
    });
  }

  const liftQueues: LiftQueue[] = [];
  for (const [name, def] of Object.entries(asRecord(doc.constructs))) {
    const c = asRecord(def);
    if (asString(c.type) !== 'queue') {
      unsupported.push(`serverless-lift construct "${name}" of type ${asString(c.type) ?? '?'} is not supported`);
      continue;
    }
    const ext = asRecord(asRecord(c.extensions).queue);
    const props = asRecord(ext.Properties);
    const queueName = asString(props.QueueName) || `${name}-${stage}`;
    const worker = asRecord(c.worker);
    liftQueues.push({
      name,
      queueName,
      fifo: Boolean(c.fifo) || queueName.endsWith('.fifo'),
      batchSize: num(c.batchSize),
      maxConcurrency: num(c.maxConcurrency),
      worker: {
        handler: asString(worker.handler),
        image: worker.image,
        timeout: num(worker.timeout),
        memorySize: num(worker.memorySize),
        environment: strEnv(worker.environment),
      },
    });
    if (c.alarm) unsupported.push(`lift alarm on ${name} is ignored`);
  }

  const cfnResources: ParsedServerless['cfnResources'] = {};
  const resourcesNode = doc.resources;
  const merged = mergeResources(resourcesNode);
  for (const [logical, body] of Object.entries(asRecord(asRecord(merged).Resources))) {
    const r = asRecord(body);
    const typ = asString(r.Type);
    if (!typ) continue;
    cfnResources[logical] = { Type: typ, Properties: asRecord(r.Properties) };
  }

  const stepFunctions: ParsedServerless['stepFunctions'] = [];
  const sfn = asRecord(doc.stepFunctions);
  for (const [name, body] of Object.entries(asRecord(sfn.stateMachines))) {
    const sm = asRecord(body);
    stepFunctions.push({ name: asString(sm.name) || `${service}-${stage}-${name}`, definition: sm.definition ?? sm.Definition });
  }

  const pkg = asRecord(doc.package);

  return {
    service,
    file,
    root,
    stage,
    region,
    runtime,
    timeout: num(provider.timeout),
    memory: num(provider.memorySize),
    environment: strEnv(provider.environment),
    functions,
    liftQueues,
    cfnResources,
    stepFunctions,
    packagePatterns: {
      include: arr(pkg.include),
      exclude: arr(pkg.exclude),
      patterns: arr(pkg.patterns),
      individually: Boolean(pkg.individually),
    },
    esbuild: Object.keys(asRecord(custom.esbuild)).length ? asRecord(custom.esbuild) : undefined,
    pythonRequirements: plugins.some((p) => /python-requirements|uv-requirements/i.test(p)),
    ctx,
    warnings,
    unsupported,
  };
}

function mergeResources(node: unknown): Record<string, unknown> {
  if (!node) return {};
  if (Array.isArray(node)) {
    const acc: Record<string, unknown> = { Resources: {} };
    for (const part of node) {
      const p = asRecord(part);
      const res = asRecord(p.Resources);
      Object.assign(asRecord(acc.Resources), res);
      for (const [k, v] of Object.entries(p)) if (k !== 'Resources') acc[k] = v;
    }
    return acc;
  }
  return asRecord(node);
}

function parseHttp(raw: unknown): SlsHttpEvent {
  if (typeof raw === 'string') {
    const [method, ...rest] = raw.trim().split(/\s+/);
    return { method: (method || 'get').toLowerCase(), path: rest.join(' ') || '/' };
  }
  const h = asRecord(raw);
  return {
    method: (asString(h.method) || 'get').toLowerCase(),
    path: asString(h.path) || '/',
    cors: Boolean(h.cors),
    private: Boolean(h.private),
    authorizer: h.authorizer,
  };
}

function parseSqs(raw: unknown): NonNullable<SlsFunction['events'][0]['sqs']> {
  if (typeof raw === 'string') return { arn: raw };
  const s = asRecord(raw);
  const arn = s.arn ?? s;
  return { arn: arn as string | Record<string, unknown>, batchSize: num(s.batchSize), maximumConcurrency: num(s.maximumConcurrency) ?? num(s.maxConcurrency) };
}

function parseS3(raw: unknown): NonNullable<SlsFunction['events'][0]['s3']> {
  if (typeof raw === 'string') return { bucket: raw, event: 's3:ObjectCreated:*' };
  const s = asRecord(raw);
  return { bucket: asString(s.bucket) || '', event: asString(s.event) || 's3:ObjectCreated:*', existing: Boolean(s.existing), rules: s.rules };
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
function arr(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.map(String) : undefined;
}
function normalizeLogical(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '');
}

export function planServerless(parsed: ParsedServerless): Plan {
  const resources: PlannedResource[] = [];
  const add = (kind: ResourceKind, name: string, detail?: string) => {
    resources.push({ kind, name, action: 'create', detail, href: uiHref(kind, name) });
  };

  for (const s of collectSecrets(parsed.ctx)) add('secret', s.name, s.keys.length ? `keys: ${s.keys.join(', ')}` : 'placeholder JSON (keys discovered at interpolate time)');
  for (const [logical, r] of Object.entries(parsed.cfnResources)) {
    const kind = cfnKind(r.Type);
    if (!kind) {
      parsed.unsupported.push(`CloudFormation ${r.Type} (${logical}) is not created`);
      continue;
    }
    const name = asString(r.Properties?.Name) || asString(r.Properties?.QueueName) || asString(r.Properties?.BucketName) || asString(r.Properties?.TableName) || asString(r.Properties?.TopicName) || logical;
    add(kind, name, r.Type);
  }
  for (const q of parsed.liftQueues) {
    add('sqs', q.queueName, q.fifo ? 'FIFO lift queue + DLQ + worker' : 'lift queue + DLQ + worker');
    if (q.worker.handler || q.worker.image) add('lambda', `${parsed.service}-${parsed.stage}-${q.name}Worker`, 'lift worker');
  }
  for (const fn of parsed.functions) {
    add('lambda', fn.deployedName, [fn.runtime, fn.handler || (fn.image ? 'image' : ''), `${fn.events.length} event(s)`].filter(Boolean).join(' · '));
    for (const ev of fn.events) {
      if (ev.http) add('apigateway', `${parsed.service}-${parsed.stage}`, `${ev.http.method.toUpperCase()} ${ev.http.path}`);
      if (ev.httpApi) add('apigatewayv2', `${parsed.service}-${parsed.stage}-http`, `${ev.httpApi.method.toUpperCase()} ${ev.httpApi.path}`);
      if (ev.schedule) {
        const rate = typeof ev.schedule === 'string' ? ev.schedule : ev.schedule.rate;
        add('event-rule', `${fn.deployedName}-schedule`, rate);
      }
      if (ev.sqs) add('event-source-mapping', `${fn.deployedName} ← ${typeof ev.sqs.arn === 'string' ? ev.sqs.arn : JSON.stringify(ev.sqs.arn)}`, 'SQS trigger');
      if (ev.s3) add('s3', ev.s3.bucket, ev.s3.event);
      if (ev.eventBridge) add('event-rule', `${fn.deployedName}-eb`, 'EventBridge');
      if (ev.sns) add('sns', String(ev.sns), 'SNS trigger (best-effort)');
      if (ev.other) parsed.unsupported.push(`event type "${ev.other}" on ${fn.name} is not created`);
      if (ev.http?.authorizer || ev.httpApi?.authorizer) parsed.unsupported.push(`authorizer on ${fn.name} is not attached`);
    }
    if (fn.image) parsed.unsupported.push(`${fn.name} uses a container image — provide a local image or skip`);
  }
  for (const sm of parsed.stepFunctions) add('sfn', sm.name);

  return {
    kind: 'serverless',
    service: parsed.service,
    source: parsed.file,
    stage: parsed.stage,
    region: parsed.region,
    resources,
    placeholders: collectSecrets(parsed.ctx).map((s) => ({ name: s.name, keys: s.keys })),
    warnings: parsed.warnings,
    unsupported: parsed.unsupported,
  };
}

function cfnKind(type: string): ResourceKind | undefined {
  switch (type) {
    case 'AWS::SQS::Queue': return 'sqs';
    case 'AWS::SNS::Topic': return 'sns';
    case 'AWS::S3::Bucket': return 's3';
    case 'AWS::DynamoDB::Table': return 'dynamodb';
    case 'AWS::SecretsManager::Secret': return 'secret';
    case 'AWS::Logs::LogGroup': return 'log-group';
    default: return undefined;
  }
}

export { asRecord, asString, strEnv, type SecretBag };
