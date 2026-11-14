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

export const LIMITS = { lambda: 64, sqs: 80, rule: 64, sfn: 80, alb: 32, targetGroup: 32 } as const;
