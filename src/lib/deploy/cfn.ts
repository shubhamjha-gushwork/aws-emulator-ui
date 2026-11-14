import { createHash } from 'crypto';

/** What a deployed CloudFormation-style resource resolves to (Ref / Fn::GetAtt). */
export interface LogicalRecord {
  name: string;
  arn?: string;
  url?: string;
  id?: string;
  kind?: string;
}
export type LogicalMap = Record<string, LogicalRecord>;

export interface PseudoParams {
  region: string;
  accountId?: string;
  stackName: string;
}

const CFN_TOKEN = '__CFN__:';

/** True when v is a CloudFormation intrinsic object such as { Ref } or { 'Fn::GetAtt': ... }. */
export function isIntrinsic(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && (keys[0] === 'Ref' || keys[0].startsWith('Fn::'));
}

/** Encode an intrinsic so it can live in a string-only map (e.g. Lambda environment) until deploy time. */
export function encodeIntrinsic(v: unknown): string {
  return CFN_TOKEN + JSON.stringify(v);
}

export function decodeIntrinsic(s: string): unknown | undefined {
  if (!s.startsWith(CFN_TOKEN)) return undefined;
  try {
    return JSON.parse(s.slice(CFN_TOKEN.length));
  } catch {
    return undefined;
  }
}

function pseudo(name: string, p: PseudoParams): string | undefined {
  switch (name) {
    case 'AWS::Region': return p.region;
    case 'AWS::AccountId': return p.accountId ?? '000000000000';
    case 'AWS::StackName': return p.stackName;
    case 'AWS::StackId': return `arn:aws:cloudformation:${p.region}:${p.accountId ?? '000000000000'}:stack/${p.stackName}/local`;
    case 'AWS::Partition': return 'aws';
    case 'AWS::URLSuffix': return 'amazonaws.com';
    default: return undefined;
  }
}

function refOf(rec: LogicalRecord): string {
  // CloudFormation Ref semantics: queue → URL, topic / secret → ARN, everything else → name.
  if (rec.kind === 'sqs') return rec.url || rec.name;
  if (rec.kind === 'sns' || rec.kind === 'secret' || rec.kind === 'sfn') return rec.arn || rec.name;
  if (rec.kind === 'apigateway' || rec.kind === 'apigatewayv2') return rec.id || rec.name;
  return rec.name;
}

function getAtt(rec: LogicalRecord, attr: string): string | undefined {
  switch (attr) {
    case 'Arn': return rec.arn;
    case 'QueueUrl': return rec.url;
    case 'QueueName': case 'TopicName': case 'Name': return rec.name;
    case 'RootResourceId': case 'ApiId': return rec.id;
    default: return undefined;
  }
}

/**
 * Resolve Ref / Fn::GetAtt / Fn::Join / Fn::Sub / Fn::Select / Fn::Split against resources created so far.
 * Returns undefined when something cannot be resolved locally (missing resource, Fn::ImportValue, conditions…).
 */
export function resolveIntrinsic(v: unknown, logical: LogicalMap, p: PseudoParams): unknown {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') {
    const decoded = decodeIntrinsic(v);
    return decoded !== undefined ? resolveIntrinsic(decoded, logical, p) : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const out = v.map((x) => resolveIntrinsic(x, logical, p));
    return out.some((x) => x === undefined) ? undefined : out;
  }
  if (typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (!isIntrinsic(o)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) {
      const r = resolveIntrinsic(val, logical, p);
      if (r === undefined) return undefined;
      out[k] = r;
    }
    return out;
  }
  if ('Ref' in o) {
    const name = String(o.Ref);
    if (name === 'AWS::NoValue') return undefined;
    const ps = pseudo(name, p);
    if (ps !== undefined) return ps;
    const rec = logical[name];
    return rec ? refOf(rec) : undefined;
  }
  if ('Fn::GetAtt' in o) {
    const g = o['Fn::GetAtt'];
    const [id, attr] = Array.isArray(g) ? [String(g[0]), String(g[1] ?? 'Arn')] : String(g).split('.');
    const rec = logical[id];
    return rec ? getAtt(rec, attr || 'Arn') : undefined;
  }
  if ('Fn::Join' in o) {
    const j = o['Fn::Join'];
    if (!Array.isArray(j) || j.length !== 2) return undefined;
    const parts = resolveIntrinsic(j[1], logical, p);
    if (!Array.isArray(parts)) return undefined;
    return parts.map(String).join(String(j[0]));
  }
  if ('Fn::Sub' in o) {
    const sub = o['Fn::Sub'];
    const [template, vars] = Array.isArray(sub) ? [String(sub[0]), (sub[1] ?? {}) as Record<string, unknown>] : [String(sub), {}];
    let failed = false;
    const out = template.replace(/\$\{([^}]+)\}/g, (_m, body: string) => {
      if (body.startsWith('!')) return `\${${body.slice(1)}}`;
      if (Object.prototype.hasOwnProperty.call(vars, body)) {
        const r = resolveIntrinsic(vars[body], logical, p);
        if (r === undefined) failed = true;
        return String(r ?? '');
      }
      const ps = pseudo(body, p);
      if (ps !== undefined) return ps;
      const [id, attr] = body.split('.');
      const rec = logical[id];
      const r = rec ? (attr ? getAtt(rec, attr) : refOf(rec)) : undefined;
      if (r === undefined) failed = true;
      return r ?? '';
    });
    return failed ? undefined : out;
  }
  if ('Fn::Select' in o) {
    const s = o['Fn::Select'];
    if (!Array.isArray(s)) return undefined;
    const list = resolveIntrinsic(s[1], logical, p);
    return Array.isArray(list) ? list[Number(s[0])] : undefined;
  }
  if ('Fn::Split' in o) {
    const s = o['Fn::Split'];
    if (!Array.isArray(s)) return undefined;
    const str = resolveIntrinsic(s[1], logical, p);
    return typeof str === 'string' ? str.split(String(s[0])) : undefined;
  }
  return undefined;
}

/** Logical ids referenced by Ref / Fn::GetAtt / Fn::Sub anywhere inside v. */
export function referencedIds(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === 'string') {
    const decoded = decodeIntrinsic(v);
    if (decoded !== undefined) referencedIds(decoded, out);
    return out;
  }
  if (Array.isArray(v)) {
    v.forEach((x) => referencedIds(x, out));
    return out;
  }
  if (!v || typeof v !== 'object') return out;
  const o = v as Record<string, unknown>;
  if (typeof o.Ref === 'string' && !o.Ref.startsWith('AWS::')) out.add(o.Ref);
  const g = o['Fn::GetAtt'];
  if (Array.isArray(g) && g[0]) out.add(String(g[0]));
  else if (typeof g === 'string') out.add(g.split('.')[0]);
  const sub = o['Fn::Sub'];
  const tpl = Array.isArray(sub) ? sub[0] : sub;
  if (typeof tpl === 'string') {
    for (const m of tpl.matchAll(/\$\{([A-Za-z0-9_]+)(?:\.[A-Za-z0-9_]+)?\}/g)) if (!m[1].startsWith('AWS')) out.add(m[1]);
  }
  for (const val of Object.values(o)) referencedIds(val, out);
  return out;
}

/** Order resources so that anything referenced is created first (stable; cycles keep file order). */
export function orderByDependencies<T>(entries: [string, T][], depsOf: (body: T) => Set<string>): [string, T][] {
  const ids = new Set(entries.map(([id]) => id));
  const byId = new Map(entries);
  const done = new Set<string>();
  const visiting = new Set<string>();
  const out: [string, T][] = [];
  const visit = (id: string) => {
    if (done.has(id) || visiting.has(id)) return;
    visiting.add(id);
    for (const d of depsOf(byId.get(id) as T)) if (ids.has(d) && d !== id) visit(d);
    visiting.delete(id);
    done.add(id);
    out.push([id, byId.get(id) as T]);
  };
  for (const [id] of entries) visit(id);
  return out;
}

/** Fit a generated name into an AWS length limit, keeping it unique with a short hash. */
export function fitName(name: string, max: number): string {
  if (name.length <= max) return name;
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 8);
  return `${name.slice(0, max - 9).replace(/[-_.]+$/, '')}-${hash}`;
}

interface NameRule {
  /** Shown in messages, e.g. "Lambda function name … (Lambda limit 64)". */
  label: string;
  service: string;
  min?: number;
  max: number;
  pattern: RegExp;
}

const ECS_NAME = /^[a-zA-Z0-9_-]+$/;
const ELB_NAME = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

/**
 * AWS naming rules (length and allowed characters) per resource kind, from each service's API reference.
 * Names written in the YAML that break them are reported and skipped, as AWS would reject them; names this
 * tool generates are shortened with fitName so they always fit.
 */
export const NAME_RULES = {
  lambda: { label: 'Lambda function', service: 'Lambda', max: 64, pattern: /^[a-zA-Z0-9_-]+$/ },
  sqs: { label: 'SQS queue', service: 'SQS', max: 80, pattern: /^[a-zA-Z0-9_-]+(\.fifo)?$/ },
  sns: { label: 'SNS topic', service: 'SNS', max: 256, pattern: /^[a-zA-Z0-9_-]+(\.fifo)?$/ },
  rule: { label: 'EventBridge rule', service: 'EventBridge', max: 64, pattern: /^[.\-_A-Za-z0-9]+$/ },
  eventBus: { label: 'EventBridge event bus', service: 'EventBridge', max: 256, pattern: /^[/.\-_A-Za-z0-9]+$/ },
  sfn: { label: 'state machine', service: 'Step Functions', max: 80, pattern: /^[^\s<>{}[\]?*"#%\\^|~`$&,;:/\u0000-\u001f\u007f-\u009f]+$/ },
  dynamodb: { label: 'DynamoDB table', service: 'DynamoDB', min: 3, max: 255, pattern: /^[a-zA-Z0-9_.-]+$/ },
  s3: { label: 'S3 bucket', service: 'S3', min: 3, max: 63, pattern: /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/ },
  logGroup: { label: 'log group', service: 'CloudWatch Logs', max: 512, pattern: /^[.\-_/#A-Za-z0-9]+$/ },
  secret: { label: 'secret', service: 'Secrets Manager', max: 512, pattern: /^[A-Za-z0-9/_+=.@-]+$/ },
  ecsCluster: { label: 'ECS cluster', service: 'ECS', max: 255, pattern: ECS_NAME },
  ecsService: { label: 'ECS service', service: 'ECS', max: 255, pattern: ECS_NAME },
  taskFamily: { label: 'task definition family', service: 'ECS', max: 255, pattern: ECS_NAME },
  ecr: { label: 'ECR repository', service: 'ECR', min: 2, max: 256, pattern: /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*$/ },
  alb: { label: 'load balancer', service: 'ELB', max: 32, pattern: ELB_NAME },
  targetGroup: { label: 'target group', service: 'ELB', max: 32, pattern: ELB_NAME },
} satisfies Record<string, NameRule>;

export type NameKind = keyof typeof NAME_RULES;

/** Length limits only, by kind. */
export const LIMITS = Object.fromEntries(Object.entries(NAME_RULES).map(([k, r]) => [k, r.max])) as { [K in NameKind]: number };

/** Why AWS would reject this name, or undefined when it is valid. */
export function invalidName(kind: NameKind, name: string): string | undefined {
  const r: NameRule = NAME_RULES[kind];
  if (name.length > r.max) return `${r.label} name ${name} is ${name.length} chars (${r.service} limit ${r.max}); skipped`;
  if (r.min !== undefined && name.length < r.min) return `${r.label} name ${name} is shorter than ${r.min} chars (${r.service} minimum); skipped`;
  if (!r.pattern.test(name)) return `${r.label} name ${name} has characters ${r.service} does not allow; skipped`;
  return undefined;
}

/** Fit a name this tool generates into the kind's AWS length limit. */
export function fitGeneratedName(kind: NameKind, name: string): string {
  return fitName(name, NAME_RULES[kind].max);
}

/** NAME_RULES kind for a CloudFormation resource type whose name we validate. */
export function nameKindForCfn(type: string): NameKind | undefined {
  switch (type) {
    case 'AWS::SQS::Queue': return 'sqs';
    case 'AWS::SNS::Topic': return 'sns';
    case 'AWS::S3::Bucket': return 's3';
    case 'AWS::DynamoDB::Table': return 'dynamodb';
    case 'AWS::SecretsManager::Secret': return 'secret';
    case 'AWS::Logs::LogGroup': return 'logGroup';
    default: return undefined;
  }
}
