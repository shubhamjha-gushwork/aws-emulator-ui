import fs from 'fs';
import path from 'path';
import { collectSecrets, createCtx, interpolateTree, PLACEHOLDER, SecretBag, type InterpCtx } from '../interpolate';
import { encodeIntrinsic, fitName, isIntrinsic, LIMITS, resolveIntrinsic } from '../cfn';
import { loadYaml } from '../yaml';
import { type Plan, type PlannedResource, uiHref, type ResourceKind } from '../types';
import { noRunDetail } from '../run-mode';

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
    schedule?: SlsSchedule;
    sqs?: { arn: string | Record<string, unknown>; batchSize?: number; maximumConcurrency?: number; enabled?: boolean };
    s3?: { bucket: string; event?: string; existing?: boolean; rules?: unknown };
    eventBridge?: Record<string, unknown>;
    sns?: SlsSns;
    other?: string;
  }[];
  /** Function-level package.patterns (used with package.individually). */
  packagePatterns?: string[];
  layers?: unknown[];
}

export interface SlsSchedule {
  /** One rule per expression (Serverless accepts a list under rate). */
  rates: string[];
  enabled: boolean;
  input?: unknown;
}

export interface SlsSns {
  topicName?: string;
  arn?: unknown;
  filterPolicy?: unknown;
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

/**
 * Lambda environment values must be strings. Numbers/booleans are stringified, an unresolved
 * secret becomes PLACEHOLDER (filled from the env file by variable name), and CloudFormation
 * intrinsics ({ Ref }, !GetAtt …) are kept as tokens resolved once resources exist.
 */
function strEnv(env: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(asRecord(env))) {
    if (v === undefined || v === null) continue;
    const s = asString(v);
    if (s !== undefined) out[k] = s;
    else if (v instanceof SecretBag) out[k] = PLACEHOLDER;
    else if (isIntrinsic(v)) out[k] = encodeIntrinsic(v);
    else if (typeof v === 'object') out[k] = JSON.stringify(v);
  }
  return out;
}

export function parseServerlessFile(file: string, opts: { stage: string; region: string; accountId?: string; env?: NodeJS.Dict<string>; fileEnv?: NodeJS.Dict<string>; regionFromFlag?: boolean }): ParsedServerless {
  const raw = fs.readFileSync(file, 'utf8');
  const doc = asRecord(loadYaml(raw, file));
  const root = path.dirname(file);
  const ctx = createCtx({ stage: opts.stage, region: opts.region, accountId: opts.accountId, root: doc, fileBase: root, env: opts.env, fileEnv: opts.fileEnv });
  interpolateTree(doc, ctx);

  const warnings = [...ctx.warnings];
  const unsupported: string[] = [];
  const service = asString(doc.service) || path.basename(root);
  const provider = asRecord(doc.provider);
  const custom = asRecord(doc.custom);
  const runtime = asString(provider.runtime);
  // --region wins (as with `serverless deploy --region`); otherwise provider.region, then the default.
  const region = opts.regionFromFlag ? opts.region : asString(provider.region) || opts.region;
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
      else if ('schedule' in e) evs.push({ schedule: parseSchedule(e.schedule) });
      else if ('sqs' in e) evs.push({ sqs: parseSqs(e.sqs) });
      else if ('s3' in e) evs.push({ s3: parseS3(e.s3) });
      else if ('eventBridge' in e) evs.push({ eventBridge: asRecord(e.eventBridge) });
      else if ('sns' in e) evs.push({ sns: parseSns(e.sns) });
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
      packagePatterns: arr(asRecord(f.package).patterns),
      layers: Array.isArray(f.layers) ? f.layers : undefined,
    });
    if (Array.isArray(f.layers) && f.layers.length) unsupported.push(`layers on ${name} are not attached (bundle dependencies into the function instead)`);
  }
  if (Object.keys(asRecord(doc.layers)).length) unsupported.push(`layers (${Object.keys(asRecord(doc.layers)).join(', ')}) are not published`);
  if (Array.isArray(provider.layers) && provider.layers.length) unsupported.push('provider.layers are not attached');

  const liftQueues: LiftQueue[] = [];
  for (const [name, def] of Object.entries(asRecord(doc.constructs))) {
    const c = asRecord(def);
    if (asString(c.type) !== 'queue') {
      unsupported.push(`serverless-lift construct "${name}" of type ${asString(c.type) ?? '?'} is not supported`);
      continue;
    }
    const ext = asRecord(asRecord(c.extensions).queue);
    const props = asRecord(ext.Properties);
    const fifo = Boolean(c.fifo);
    const baseName = asString(props.QueueName) || `${name}-${stage}`;
    const queueName = fifo && !baseName.endsWith('.fifo') ? `${baseName}.fifo` : baseName;
    const worker = asRecord(c.worker);
    liftQueues.push({
      name,
      queueName,
      fifo: fifo || queueName.endsWith('.fifo'),
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
    if (Array.isArray(sm.events) && sm.events.length) unsupported.push(`events on state machine ${name} are not created`);
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

function parseSchedule(raw: unknown): SlsSchedule {
  if (typeof raw === 'string') return { rates: [raw], enabled: true };
  const s = asRecord(raw);
  const rate = s.rate;
  const rates = (Array.isArray(rate) ? rate : [rate]).map((r) => asString(r)).filter((r): r is string => Boolean(r));
  return { rates, enabled: s.enabled === undefined ? true : s.enabled !== false && s.enabled !== 'false', input: s.input };
}

function parseSns(raw: unknown): SlsSns {
  if (typeof raw === 'string') {
    return raw.startsWith('arn:') ? { arn: raw, topicName: raw.split(':').pop() } : { topicName: raw };
  }
  const s = asRecord(raw);
  const arn = s.arn;
  const fromArn = typeof arn === 'string' && arn.startsWith('arn:') ? arn.split(':').pop() : undefined;
  return { topicName: asString(s.topicName) || fromArn, arn, filterPolicy: s.filterPolicy };
}

/** Lift dead-letter queue name: <queue>-dlq(.fifo), kept within the SQS name limit. */
export function liftDlqName(queueName: string, fifo: boolean): string {
  return fitName(`${queueName.replace(/\.fifo$/, '')}-dlq`, LIMITS.sqs - (fifo ? 5 : 0)) + (fifo ? '.fifo' : '');
}

/** Rule names derived from the function name, shortened to EventBridge's 64-char limit. */
export function scheduleRuleName(fnName: string, index: number): string {
  return fitName(index === 0 ? `${fnName}-schedule` : `${fnName}-schedule-${index + 1}`, LIMITS.rule);
}

export function eventBridgeRuleName(fnName: string, index: number): string {
  return fitName(index === 0 ? `${fnName}-eb` : `${fnName}-eb-${index + 1}`, LIMITS.rule);
}

/** Name validation shared by plan and apply. Returns a reason when the name cannot be created. */
export function invalidLambdaName(name: string): string | undefined {
  if (name.length > LIMITS.lambda) return `function name ${name} is ${name.length} chars (Lambda limit ${LIMITS.lambda}); skipped`;
  if (!/^[a-zA-Z0-9-_]+$/.test(name)) return `function name ${name} has characters Lambda does not allow; skipped`;
  return undefined;
}

export function invalidQueueName(name: string): string | undefined {
  if (name.length > LIMITS.sqs) return `queue name ${name} is ${name.length} chars (SQS limit ${LIMITS.sqs}); skipped`;
  if (!/^[a-zA-Z0-9_-]+(\.fifo)?$/.test(name)) return `queue name ${name} has characters SQS does not allow; skipped`;
  return undefined;
}

/** Physical name for a CloudFormation resource, as apply will create it (intrinsics resolved when possible). */
export function cfnPhysicalName(logical: string, r: { Type: string; Properties?: Record<string, unknown> }, pseudo: { region: string; stackName: string }, resolved = {}): string | undefined {
  const p = r.Properties ?? {};
  const pick = (v: unknown) => {
    if (v === undefined || v === null) return undefined;
    const out = resolveIntrinsic(v, resolved, pseudo);
    return typeof out === 'string' ? out : undefined;
  };
  switch (r.Type) {
    case 'AWS::SQS::Queue': {
      const raw = p.QueueName === undefined ? logical : pick(p.QueueName);
      if (raw === undefined) return undefined;
      const fifo = p.FifoQueue === true || p.FifoQueue === 'true';
      return fifo && !raw.endsWith('.fifo') ? `${raw}.fifo` : raw;
    }
    case 'AWS::S3::Bucket': return p.BucketName === undefined ? logical.toLowerCase() : pick(p.BucketName);
    case 'AWS::SNS::Topic': return p.TopicName === undefined ? logical : pick(p.TopicName);
    case 'AWS::DynamoDB::Table': return p.TableName === undefined ? logical : pick(p.TableName);
    case 'AWS::SecretsManager::Secret': return p.Name === undefined ? logical : pick(p.Name);
    case 'AWS::Logs::LogGroup': return p.LogGroupName === undefined ? logical : pick(p.LogGroupName);
    default: return logical;
  }
}

function parseSqs(raw: unknown): NonNullable<SlsFunction['events'][0]['sqs']> {
  if (typeof raw === 'string') return { arn: raw };
  const s = asRecord(raw);
  const arn = s.arn ?? s;
  return { arn: arn as string | Record<string, unknown>, batchSize: num(s.batchSize), maximumConcurrency: num(s.maximumConcurrency) ?? num(s.maxConcurrency), enabled: s.enabled === false ? false : undefined };
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
/** Serverless Framework logical id naming: hello → Hello, my-fn → MyDashfn, my_fn → MyUnderscorefn. */
export function normalizeLogical(name: string): string {
  const n = name.replace(/-/g, 'Dash').replace(/_/g, 'Underscore').replace(/[^A-Za-z0-9]/g, '');
  return n.charAt(0).toUpperCase() + n.slice(1);
}

export function planServerless(parsed: ParsedServerless, opts: { noRun?: boolean } = {}): Plan {
  const resources: PlannedResource[] = [];
  const warnings = [...parsed.warnings];
  const unsupported = [...parsed.unsupported];
  const add = (kind: ResourceKind, name: string, detail?: string) => {
    resources.push({ kind, name, action: 'create', detail, href: uiHref(kind, name) });
  };
  const pseudo = { region: parsed.region, stackName: `${parsed.service}-${parsed.stage}` };
  const buses = new Set<string>();
  const showArn = (v: unknown) => {
    if (typeof v === 'string') return v;
    const r = resolveIntrinsic(v, {}, pseudo);
    if (typeof r === 'string') return r;
    const id = refTarget(v);
    return id ? `${id} (from this stack)` : JSON.stringify(v);
  };

  for (const s of collectSecrets(parsed.ctx)) add('secret', s.name, s.keys.length ? `keys: ${s.keys.join(', ')}` : 'placeholder JSON (keys discovered at interpolate time)');
  for (const [logical, r] of Object.entries(parsed.cfnResources)) {
    const kind = cfnKind(r.Type);
    if (!kind) {
      unsupported.push(`CloudFormation ${r.Type} (${logical}) is not created`);
      continue;
    }
    const name = cfnPhysicalName(logical, r, pseudo);
    if (kind === 'sqs' && name) {
      const bad = invalidQueueName(name);
      if (bad) {
        warnings.push(bad);
        continue;
      }
    }
    add(kind, name ?? `${logical} (name resolved at deploy)`, r.Type);
  }
  for (const q of parsed.liftQueues) {
    add('sqs', q.queueName, noRunDetail(!!opts.noRun, q.fifo ? 'FIFO lift queue + DLQ + worker' : 'lift queue + DLQ + worker'));
    add('sqs', liftDlqName(q.queueName, !!q.fifo), 'lift dead-letter queue');
    if (q.worker.handler || q.worker.image) add('lambda', `${parsed.service}-${parsed.stage}-${q.name}Worker`, 'lift worker');
  }
  for (const fn of parsed.functions) {
    const bad = invalidLambdaName(fn.deployedName);
    if (bad) {
      warnings.push(bad);
      continue;
    }
    add('lambda', fn.deployedName, [fn.runtime, fn.handler || (fn.image ? 'image' : ''), `${fn.events.length} event(s)`].filter(Boolean).join(' · '));
    let sched = 0;
    let eb = 0;
    for (const ev of fn.events) {
      if (ev.http) add('apigateway', `${parsed.service}-${parsed.stage}`, `${restMethod(ev.http.method)} ${ev.http.path}`);
      if (ev.httpApi) add('apigatewayv2', `${parsed.service}-${parsed.stage}-http`, httpRouteKey(ev.httpApi.method, ev.httpApi.path));
      if (ev.schedule) {
        if (!ev.schedule.rates.length) warnings.push(`${fn.name}: schedule event without a rate is skipped`);
        for (const rate of ev.schedule.rates) {
          const off = !!opts.noRun || !ev.schedule.enabled;
          add('event-rule', scheduleRuleName(fn.deployedName, sched++), [rate, off ? `DISABLED${opts.noRun ? ' (--no-run)' : ' (enabled: false)'}` : ''].filter(Boolean).join(' · '));
        }
      }
      if (ev.sqs) add('event-source-mapping', `${fn.deployedName} ← ${showArn(ev.sqs.arn)}`, noRunDetail(!!opts.noRun, 'SQS trigger'));
      if (ev.s3) add('s3', ev.s3.bucket, opts.noRun ? `${ev.s3.event} · notification skipped (--no-run)` : ev.s3.event);
      const bus = ev.eventBridge ? busName(ev.eventBridge) : 'default';
      if (bus !== 'default' && !buses.has(bus)) {
        buses.add(bus);
        add('event-bus', bus, 'custom event bus (created if missing)');
      }
      if (ev.eventBridge) add('event-rule', eventBridgeRuleName(fn.deployedName, eb++), noRunDetail(!!opts.noRun, `EventBridge${busName(ev.eventBridge) !== 'default' ? ` on bus ${busName(ev.eventBridge)}` : ''}`));
      if (ev.sns) {
        const topic = ev.sns.topicName ?? (typeof ev.sns.arn === 'string' ? ev.sns.arn : refTarget(ev.sns.arn));
        add('sns', topic ?? 'unknown topic', opts.noRun ? 'topic only · subscription skipped (--no-run)' : 'topic + Lambda subscription');
      }
      if (ev.other) unsupported.push(`event type "${ev.other}" on ${fn.name} is not created`);
      if (ev.http?.authorizer || ev.httpApi?.authorizer) unsupported.push(`authorizer on ${fn.name} is not attached`);
    }
    if (fn.image) unsupported.push(`${fn.name} uses a container image — provide a local image or skip`);
  }
  for (const sm of parsed.stepFunctions) {
    if (sm.name.length > LIMITS.sfn) {
      warnings.push(`state machine name ${sm.name} is ${sm.name.length} chars (limit ${LIMITS.sfn}); skipped`);
      continue;
    }
    add('sfn', sm.name);
  }

  return {
    kind: 'serverless',
    service: parsed.service,
    source: parsed.file,
    stage: parsed.stage,
    region: parsed.region,
    resources,
    placeholders: collectSecrets(parsed.ctx).map((s) => ({ name: s.name, keys: s.keys, defaulted: s.defaulted })),
    warnings,
    unsupported,
  };
}

function refTarget(v: unknown): string | undefined {
  const o = asRecord(v);
  if (typeof o.Ref === 'string') return o.Ref;
  const g = o['Fn::GetAtt'];
  if (Array.isArray(g)) return String(g[0]);
  if (typeof g === 'string') return g.split('.')[0];
  return undefined;
}

export function busName(eb: Record<string, unknown>): string {
  const raw = asString(eb.eventBus) || asString(eb.eventBusName) || 'default';
  return raw.startsWith('arn:') ? raw.split('/').pop() || 'default' : raw;
}

/** Serverless `method: '*'` / `any` → API Gateway ANY. */
export function restMethod(method: string): string {
  const m = method.toUpperCase();
  return m === '*' ? 'ANY' : m;
}

/** HTTP API route key; Serverless `httpApi: '*'` is the catch-all $default route. */
export function httpRouteKey(method: string, routePath: string): string {
  const m = method.toUpperCase();
  if (m === '*' && (routePath === '/' || routePath === '*' || !routePath)) return '$default';
  return `${m === '*' ? 'ANY' : m} ${routePath.startsWith('/') ? routePath : `/${routePath}`}`;
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

export { asRecord, asString, strEnv };
