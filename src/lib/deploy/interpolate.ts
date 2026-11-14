import fs from 'fs';
import path from 'path';
import { PLACEHOLDER_VALUE } from './types';
import { loadYaml } from './yaml';

export const PLACEHOLDER = 'PLACEHOLDER';

/** Returned when a SecretBag key is not in the local env file. Not a value — never print it. */
export const MISSING_SECRET = Symbol('MISSING_SECRET');

export class SecretBag {
  readonly name: string;
  readonly source: string;
  readonly keys = new Set<string>();
  /** Local --env-file values only (never process.env). Used so YAML defaults do not hide a present key. */
  readonly fileEnv: NodeJS.Dict<string>;
  constructor(name: string, source: string, fileEnv?: NodeJS.Dict<string>) {
    this.name = name;
    this.source = source;
    this.fileEnv = fileEnv ?? {};
  }
  get(key: string): string | typeof MISSING_SECRET {
    this.keys.add(key);
    if (Object.prototype.hasOwnProperty.call(this.fileEnv, key)) {
      const v = this.fileEnv[key];
      if (v !== undefined && v !== '') return v;
    }
    return MISSING_SECRET;
  }
  toJSON() {
    return { __secret: this.name, keys: [...this.keys] };
  }
}

export interface InterpCtx {
  stage: string;
  region: string;
  accountId: string;
  root: Record<string, unknown>;
  env: NodeJS.Dict<string>;
  fileBase: string;
  secrets: Map<string, SecretBag>;
  /** Env-file values only; SecretBag reads this, not process.env. */
  fileEnv: NodeJS.Dict<string>;
  /** Secret keys that used a YAML default because they were missing from the env file. Names only. */
  defaultedKeys: Set<string>;
  constructs: Record<string, Record<string, string>>;
  warnings: string[];
  visiting: Set<string>;
  /** Inside a CloudFormation Fn::Sub string. */
  inSub?: boolean;
  /** Variable paths currently being resolved; a repeat means a circular reference. */
  resolving: Set<string>;
  /** Paths found to be circular; left unresolved from then on. */
  circular: Set<string>;
  /** Nesting depth guard for re-interpolation. */
  depth: number;
}

export function createCtx(opts: {
  stage: string;
  region: string;
  accountId?: string;
  root: Record<string, unknown>;
  fileBase: string;
  env?: NodeJS.Dict<string>;
  fileEnv?: NodeJS.Dict<string>;
}): InterpCtx {
  return {
    stage: opts.stage,
    region: opts.region,
    accountId: opts.accountId ?? '000000000000',
    root: opts.root,
    env: opts.env ?? process.env,
    fileBase: opts.fileBase,
    secrets: new Map(),
    fileEnv: opts.fileEnv ?? {},
    defaultedKeys: new Set(),
    constructs: {},
    warnings: [],
    visiting: new Set(),
    resolving: new Set(),
    circular: new Set(),
    depth: 0,
  };
}

/** Walk a document, interpolating strings in place. Returns the same reference. */
export function interpolateTree<T>(value: T, ctx: InterpCtx): T {
  return walk(value, ctx) as T;
}

function walk(value: unknown, ctx: InterpCtx): unknown {
  if (typeof value === 'string') return interpolateString(value, ctx);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = walk(value[i], ctx);
    return value;
  }
  if (value && typeof value === 'object' && !(value instanceof SecretBag)) {
    const obj = value as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      // CloudFormation Fn::Sub owns ${Name} / ${AWS::Region}; only resolve Serverless sources inside it.
      obj[k] = k === 'Fn::Sub' ? walkSub(obj[k], ctx) : walk(obj[k], ctx);
    }
    return obj;
  }
  return value;
}

function walkSub(value: unknown, ctx: InterpCtx): unknown {
  const prev = ctx.inSub;
  ctx.inSub = true;
  try {
    return walk(value, ctx);
  } finally {
    ctx.inSub = prev;
  }
}

/** True for ${...} bodies that belong to CloudFormation, not Serverless (e.g. AWS::Region, Logical.Arn inside Fn::Sub). */
function isCfnExpression(expr: string, ctx: InterpCtx): boolean {
  if (/^AWS::[A-Za-z]+$/.test(expr.trim())) return true;
  if (expr.startsWith('!')) return true;
  return Boolean(ctx.inSub) && /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)?$/.test(expr.trim());
}

/**
 * Replace ${...} expressions, including nested ones. If the whole string is a
 * single expression that resolves to a non-string (object, SecretBag, array),
 * that value is returned instead of being stringified.
 */
export function interpolateString(input: string, ctx: InterpCtx): unknown {
  if (!input.includes('${')) return input;
  if (ctx.depth > 40) {
    addWarning(ctx, `variable nesting too deep in "${input.slice(0, 60)}"; left unresolved`);
    return input;
  }
  ctx.depth++;
  try {
    return interpolateOnce(input, ctx);
  } finally {
    ctx.depth--;
  }
}

function addWarning(ctx: InterpCtx, w: string) {
  if (!ctx.warnings.includes(w)) ctx.warnings.push(w);
}

function interpolateOnce(input: string, ctx: InterpCtx): unknown {
  const spans = findExpressions(input);
  if (spans.length === 1 && spans[0].start === 0 && spans[0].end === input.length) {
    return resolveExpr(spans[0].body, ctx);
  }
  let out = '';
  let last = 0;
  for (const s of spans) {
    out += input.slice(last, s.start);
    const v = resolveExpr(s.body, ctx);
    out += v === undefined || v === null ? '' : stringify(v);
    last = s.end;
  }
  out += input.slice(last);
  // A pass may have introduced new expressions (defaults, nested self).
  if (out.includes('${') && out !== input) return interpolateString(out, ctx);
  return out;
}

function stringify(v: unknown): string {
  if (v === MISSING_SECRET || v instanceof SecretBag) return PLACEHOLDER;
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function findExpressions(s: string): { start: number; end: number; body: string }[] {
  const out: { start: number; end: number; body: string }[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '$' && s[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      for (; j < s.length; j++) {
        if (s[j] === '{') depth++;
        else if (s[j] === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      if (depth === 0) {
        out.push({ start: i, end: j + 1, body: s.slice(i + 2, j) });
        i = j;
      }
    }
  }
  return out;
}

function splitDefault(expr: string): { path: string; def?: string } {
  // ${path, 'default'} or ${path, "default"} or ${path:-default} (seen in trinity files)
  const dash = expr.match(/^([\s\S]+?):-(.*)$/);
  if (dash && !dash[1].includes('${')) return { path: dash[1].trim(), def: dash[2] };
  let depth = 0;
  let inS = false;
  let inD = false;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (!inS && !inD) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === ',' && depth === 0) {
        const def = unquote(expr.slice(i + 1).trim());
        return { path: expr.slice(0, i).trim(), def };
      }
    }
  }
  return { path: expr.trim() };
}

function unquote(s: string): string {
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) return s.slice(1, -1);
  return s;
}

class CircularReference extends Error {}

function resolveExpr(expr: string, ctx: InterpCtx): unknown {
  if (isCfnExpression(expr, ctx)) return `\${${expr}}`;
  const { path: rawPath, def } = splitDefault(expr);
  // Nested expressions inside the path (e.g. self:custom.x.${self:custom.stage})
  const interpolatedPath = interpolateString(rawPath, ctx);
  const pathStr = typeof interpolatedPath === 'string' ? interpolatedPath : rawPath;
  if (ctx.circular.has(pathStr)) return def !== undefined ? maybeInterpDefault(def, ctx) : `\${${expr}}`;
  try {
    let v = resolvePath(pathStr, ctx);
    // A referenced value may itself contain variables that have not been walked yet (forward reference).
    if (typeof v === 'string' && v.includes('${')) {
      if (ctx.resolving.has(pathStr)) {
        ctx.circular.add(pathStr);
        throw new CircularReference(`circular reference via \${${pathStr}}`);
      }
      ctx.resolving.add(pathStr);
      try {
        v = interpolateString(v, ctx);
      } finally {
        ctx.resolving.delete(pathStr);
      }
    }
    // A missing secret key is unset: YAML defaults must win. Placeholders only when there is no default.
    if (v === MISSING_SECRET || v === PLACEHOLDER || v === PLACEHOLDER_VALUE) {
      if (def !== undefined) {
        const key = pathStr.split('.').pop();
        if (key) ctx.defaultedKeys.add(key);
        return maybeInterpDefault(def, ctx);
      }
      return PLACEHOLDER;
    }
    if (v === undefined || v === null || v === '') {
      if (def !== undefined) return maybeInterpDefault(def, ctx);
      const kind = kindOf(pathStr);
      if (kind === 'env') {
        addWarning(ctx, `\${env:${pathStr.slice(4)}} is unset; using a placeholder`);
        return PLACEHOLDER;
      }
      if (v !== '' && (kind === 'self' || kind === 'opt' || kind === 'sls' || kind === 'cf' || kind === 's3' || kind === 'param')) {
        addWarning(ctx, `\${${pathStr}} could not be resolved (no value and no default)`);
      }
      return v;
    }
    return v;
  } catch (e) {
    if (def !== undefined && !(e instanceof CircularReference)) return maybeInterpDefault(def, ctx);
    addWarning(ctx, `unresolved \${${expr}}: ${(e as Error).message}`);
    if (e instanceof CircularReference && def !== undefined) return maybeInterpDefault(def, ctx);
    return `\${${expr}}`;
  }
}

function maybeInterpDefault(def: string, ctx: InterpCtx): unknown {
  return def.includes('${') ? interpolateString(def, ctx) : def;
}

function kindOf(p: string): string {
  const i = p.indexOf(':');
  return i >= 0 ? p.slice(0, i) : '';
}

function resolvePath(p: string, ctx: InterpCtx): unknown {
  const colon = p.indexOf(':');
  const kind = colon >= 0 ? p.slice(0, colon) : '';
  const rest = colon >= 0 ? p.slice(colon + 1) : p;

  if (kind === 'opt') {
    if (rest === 'stage') return ctx.stage;
    if (rest === 'region') return ctx.region;
    return ctx.env[`SLS_OPT_${rest}`] ?? undefined;
  }
  if (kind === 'env') {
    return ctx.env[rest];
  }
  if (kind === 'aws') {
    if (rest === 'accountId') return ctx.accountId;
    if (rest === 'region') return ctx.region;
    return undefined;
  }
  if (kind === 'self') return getPath(ctx.root, rest);
  if (kind === 'file' || rest.startsWith('file(') || p.startsWith('file(')) {
    const m = (kind === 'file' ? rest : p).match(/^file\(([^)]+)\)(?::(.*))?$/);
    const spec = kind === 'file' ? rest : p;
    const mm = spec.match(/^file\(([^)]+)\)(?::(.*))?$/) || m;
    if (!mm) throw new Error(`bad file expression: ${p}`);
    return loadFile(mm[1], mm[2], ctx);
  }
  if (kind === 'ssm' || kind.startsWith('ssm(')) {
    return resolveSsm(rest, ctx);
  }
  if (kind === 'construct') {
    const [name, attr] = rest.split('.');
    return ctx.constructs[name]?.[attr] ?? `__CONSTRUCT__:${rest}`;
  }
  if (kind === 'sls') {
    if (rest === 'stage') return ctx.stage;
    if (rest === 'instanceId') return 'local';
    return undefined;
  }
  // Trinity (and some serverless) paths are bare: custom.stage, environment.refs.X
  return getPath(ctx.root, p);
}

function resolveSsm(spec: string, ctx: InterpCtx): SecretBag {
  // /aws/reference/secretsmanager/NAME or NAME
  const ref = spec.replace(/^\/aws\/reference\/secretsmanager\//, '');
  const name = localSecretName(ctx.stage, ref);
  let bag = ctx.secrets.get(name);
  if (!bag) {
    bag = new SecretBag(name, spec, ctx.fileEnv);
    ctx.secrets.set(name, bag);
  }
  return bag;
}

export function localSecretName(stage: string, original: string): string {
  const leaf = original.replace(/^\/+/, '').replace(/\/+$/, '');
  if (leaf.startsWith('aws-emulator/')) return leaf;
  if (leaf.startsWith(`${stage}/`)) return `aws-emulator/${leaf}`;
  return `aws-emulator/${stage}/${leaf}`;
}

function loadFile(rel: string, subpath: string | undefined, ctx: InterpCtx): unknown {
  const file = path.resolve(ctx.fileBase, rel);
  if (ctx.visiting.has(file)) throw new Error(`circular file() include: ${rel}`);
  ctx.visiting.add(file);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    let doc: unknown;
    if (/\.ya?ml$/i.test(file)) doc = loadYaml(raw, file);
    else if (/\.json$/i.test(file)) doc = JSON.parse(raw);
    else doc = raw;
    // ${self:} always refers to the service document, not the included file (Serverless Framework behavior).
    const child: InterpCtx = { ...ctx, fileBase: path.dirname(file) };
    const walked = interpolateTree(doc, child);
    // merge secret bags
    for (const [k, v] of child.secrets) ctx.secrets.set(k, v);
    ctx.warnings.push(...child.warnings.filter((w) => !ctx.warnings.includes(w)));
    if (subpath) return getPath(walked, subpath);
    return walked;
  } finally {
    ctx.visiting.delete(file);
  }
}

export function getPath(obj: unknown, dotted: string): unknown {
  if (!dotted) return obj;
  const parts = dotted.split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur instanceof SecretBag) return cur.get(part);
    if (cur === undefined || cur === null) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** After constructs are filled, replace leftover __CONSTRUCT__: tokens. */
export function resolveConstructTokens<T>(value: T, ctx: InterpCtx): T {
  const again = (v: unknown): unknown => {
    if (typeof v === 'string' && v.startsWith('__CONSTRUCT__:')) {
      const rest = v.slice('__CONSTRUCT__:'.length);
      const [name, attr] = rest.split('.');
      return ctx.constructs[name]?.[attr] ?? v;
    }
    if (typeof v === 'string' && v.includes('__CONSTRUCT__:')) {
      return v.replace(/__CONSTRUCT__:([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/g, (_, n, a) => ctx.constructs[n]?.[a] ?? `__CONSTRUCT__:${n}.${a}`);
    }
    if (Array.isArray(v)) return v.map(again);
    if (v && typeof v === 'object' && !(v instanceof SecretBag)) {
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) o[k] = again(o[k]);
      return o;
    }
    return v;
  };
  return again(value) as T;
}


/**
 * Turn Secrets Manager ARNs / ssm paths written as plain strings
 * (common in Trinity environment.refs) into SecretBags so key lookups are tracked.
 * The original account id in an ARN is not stored or logged.
 */
export function promoteSecretsManagerRefs(value: unknown, ctx: InterpCtx): void {
  const walk = (v: unknown, parent?: Record<string, unknown>, key?: string): void => {
    if (typeof v === 'string' && parent && key !== undefined) {
      const bag = secretBagFromRefString(v, ctx);
      if (bag) parent[key] = bag;
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === 'string') {
          const bag = secretBagFromRefString(item, ctx);
          if (bag) v[i] = bag;
        } else {
          walk(item);
        }
      });
      return;
    }
    if (v && typeof v === 'object' && !(v instanceof SecretBag)) {
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) walk(o[k], o, k);
    }
  };
  walk(value);
}

function secretBagFromRefString(raw: string, ctx: InterpCtx): SecretBag | undefined {
  const s = raw.trim();
  if (!s || s.startsWith('${')) return undefined;
  let leaf: string | undefined;
  const arn = s.match(/^arn:aws:secretsmanager:[^:]+:[^:]+:secret:(.+)$/i);
  // Full Secrets Manager ARNs end in -XXXXXX (6 random chars) that is not part of the secret name.
  if (arn) leaf = arn[1].replace(/-[A-Za-z0-9]{6}$/, '');
  else if (/\/aws\/reference\/secretsmanager\//i.test(s)) {
    leaf = s.replace(/^.*\/aws\/reference\/secretsmanager\//i, '');
  } else {
    return undefined;
  }
  leaf = leaf.replace(/-\*$/, '');
  const name = localSecretName(ctx.stage, leaf);
  let bag = ctx.secrets.get(name);
  if (!bag) {
    bag = new SecretBag(name, 'secretsmanager', ctx.fileEnv);
    ctx.secrets.set(name, bag);
  }
  return bag;
}

export function collectSecrets(ctx: InterpCtx): { name: string; keys: string[]; source: string; defaulted: string[] }[] {
  return [...ctx.secrets.values()].map((b) => ({
    name: b.name,
    keys: [...b.keys].sort(),
    source: b.source,
    defaulted: [...b.keys].filter((k) => ctx.defaultedKeys.has(k)).sort(),
  }));
}

export { PLACEHOLDER_VALUE };
