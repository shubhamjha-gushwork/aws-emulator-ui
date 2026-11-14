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
  /** True once a variable reads this secret (a key, or the whole secret). Unreferenced Trinity refs are not created. */
  referenced = false;
  /** Local --env-file values only (never process.env). Used so YAML defaults do not hide a present key. */
  readonly fileEnv: NodeJS.Dict<string>;
  constructor(name: string, source: string, fileEnv?: NodeJS.Dict<string>) {
    this.name = name;
    this.source = source;
    this.fileEnv = fileEnv ?? {};
  }
  get(key: string): string | typeof MISSING_SECRET {
    this.keys.add(key);
    this.referenced = true;
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
  /**
   * Stages to retry, in order, when a stage-keyed lookup (a path containing a nested variable that
   * evaluates to the current stage, e.g. ${self:custom.${sls:stage}.x}) has no value and no explicit default.
   */
  fallbackStages: string[];
  /** 'serverless' follows Serverless Framework variable syntax; 'trinity' also allows bare document paths and ${x:-default}. */
  dialect: Dialect;
}

export type Dialect = 'serverless' | 'trinity';

/** Default for --fallback-stage. */
export const DEFAULT_FALLBACK_STAGES = ['dev'];

export function createCtx(opts: {
  stage: string;
  region: string;
  accountId?: string;
  root: Record<string, unknown>;
  fileBase: string;
  env?: NodeJS.Dict<string>;
  fileEnv?: NodeJS.Dict<string>;
  fallbackStages?: string[];
  dialect?: Dialect;
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
    fallbackStages: [...new Set(opts.fallbackStages ?? DEFAULT_FALLBACK_STAGES)].filter((s) => s && s !== opts.stage),
    dialect: opts.dialect ?? 'serverless',
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

interface Fallback {
  raw: string;
  /** Always a literal string (the right-hand side of ${x:-default}). */
  literal?: boolean;
}

/**
 * Split `path, fallback1, fallback2…` at top-level commas (Serverless Framework syntax). Trinity files
 * may also use the shell-style `path:-default`.
 */
function splitFallbacks(expr: string, ctx: InterpCtx): { path: string; fallbacks: Fallback[] } {
  const parts: string[] = [];
  let depth = 0;
  let inS = false;
  let inD = false;
  let last = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (!inS && !inD) {
      if (c === '{' || c === '(') depth++;
      else if (c === '}' || c === ')') depth--;
      else if (c === ',' && depth === 0) {
        parts.push(expr.slice(last, i).trim());
        last = i + 1;
      }
    }
  }
  parts.push(expr.slice(last).trim());
  const [first, ...rest] = parts;
  const fallbacks: Fallback[] = rest.map((raw) => ({ raw }));
  if (ctx.dialect === 'trinity') {
    const dash = first.match(/^([\s\S]+?):-([\s\S]*)$/);
    if (dash && !dash[1].includes('${')) return { path: dash[1].trim(), fallbacks: [{ raw: dash[2], literal: true }, ...fallbacks] };
  }
  return { path: first, fallbacks };
}

function unquote(s: string): string {
  if (s.length >= 2 && ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"')))) return s.slice(1, -1);
  return s;
}

/** Variable sources Serverless resolves; a fallback naming one of these is a reference, not a literal. */
const SOURCE_RE = /^(self|env|opt|sls|aws|ssm|cf|s3|param|construct|file|strToBool)\s*[:(]/;

class CircularReference extends Error {}

const STAGE_SLOT = Symbol('STAGE_SLOT');

/**
 * The lookup path with nested variables resolved, plus the same path for each fallback stage. A nested
 * variable whose value is the current stage marks a stage-keyed lookup; those slots are swapped for the
 * fallback stage.
 */
function candidatePaths(rawPath: string, ctx: InterpCtx): { path: string; stage?: string }[] {
  const spans = findExpressions(rawPath);
  if (!spans.length) return [{ path: rawPath.trim() }];
  const pieces: (string | typeof STAGE_SLOT)[] = [];
  let last = 0;
  let stageKeyed = false;
  for (const s of spans) {
    pieces.push(rawPath.slice(last, s.start));
    const v = interpolateString(rawPath.slice(s.start, s.end), ctx);
    const str = v === undefined || v === null ? '' : stringify(v);
    if (str === ctx.stage) {
      pieces.push(STAGE_SLOT);
      stageKeyed = true;
    } else pieces.push(str);
    last = s.end;
  }
  pieces.push(rawPath.slice(last));
  const build = (stage: string) => {
    const out = pieces.map((p) => (p === STAGE_SLOT ? stage : p)).join('').trim();
    if (!out.includes('${')) return out;
    const again = interpolateString(out, ctx);
    return typeof again === 'string' ? again.trim() : out;
  };
  const out: { path: string; stage?: string }[] = [{ path: build(ctx.stage) }];
  if (stageKeyed) for (const st of ctx.fallbackStages) out.push({ path: build(st), stage: st });
  return out;
}

/** "custom.local is not defined for stage local; using custom.dev" — names only, deduped per stage block. */
function noteStageFallback(primary: string, alt: string, stage: string, ctx: InterpCtx) {
  const a = primary.split('.');
  const b = alt.split('.');
  let i = 0;
  while (i < a.length - 1 && i < b.length - 1 && a[i] === b[i]) i++;
  addWarning(ctx, `${a.slice(0, i + 1).join('.')} is not defined for stage ${ctx.stage}; using ${b.slice(0, i + 1).join('.')} (fallback stage ${stage}, see --fallback-stage)`);
}

/** Look one path up, resolving variables inside the value it points at (forward references). */
function lookup(pathStr: string, ctx: InterpCtx): unknown {
  let v = resolvePath(pathStr, ctx);
  if (v instanceof SecretBag) v.referenced = true;
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
  return v;
}

function unresolved(v: unknown): boolean {
  return v === undefined || v === null || v === '' || v === MISSING_SECRET || v === PLACEHOLDER || v === PLACEHOLDER_VALUE;
}

/** Evaluate one fallback: quoted strings, numbers and booleans are literals; variable sources are resolved. */
function evalFallback(f: Fallback, ctx: InterpCtx): unknown {
  if (f.literal) return maybeInterp(f.raw, ctx);
  const raw = f.raw.trim();
  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) return maybeInterp(unquote(raw), ctx);
  if (raw.includes('${')) return interpolateString(raw, ctx);
  if (SOURCE_RE.test(raw) || (ctx.dialect === 'trinity' && isDocumentPath(raw, ctx))) return interpolateString(`\${${raw}}`, ctx);
  return raw;
}

/** First fallback that resolves wins; the last one is used as-is (so `, ''` gives an empty string). */
function resolveFallbacks(fallbacks: Fallback[], ctx: InterpCtx): unknown {
  for (let i = 0; i < fallbacks.length; i++) {
    const v = evalFallback(fallbacks[i], ctx);
    if (i === fallbacks.length - 1 || !unresolved(v)) return v;
  }
  return undefined;
}

function resolveExpr(expr: string, ctx: InterpCtx): unknown {
  if (isCfnExpression(expr, ctx)) return `\${${expr}}`;
  const { path: rawPath, fallbacks } = splitFallbacks(expr, ctx);
  const hasDefault = fallbacks.length > 0;
  // Stage fallback only for lookups without an explicit default: a written default always wins.
  const candidates = hasDefault ? candidatePaths(rawPath, ctx).slice(0, 1) : candidatePaths(rawPath, ctx);
  let pathStr = candidates[0].path;
  if (ctx.circular.has(pathStr)) return hasDefault ? resolveFallbacks(fallbacks, ctx) : `\${${expr}}`;
  try {
    let v: unknown;
    for (const c of candidates) {
      v = lookup(c.path, ctx);
      if (v !== undefined) {
        if (c.stage) noteStageFallback(candidates[0].path, c.path, c.stage, ctx);
        pathStr = c.path;
        break;
      }
    }
    // A missing secret key is unset: YAML defaults must win. Placeholders only when there is no default.
    if (v === MISSING_SECRET || v === PLACEHOLDER || v === PLACEHOLDER_VALUE) {
      if (hasDefault) {
        const out = resolveFallbacks(fallbacks, ctx);
        // The key counts as defaulted only when a fallback really supplied a value (an empty string is a value).
        const key = pathStr.split('.').pop();
        if (key && out !== undefined && out !== null && out !== PLACEHOLDER && out !== MISSING_SECRET && out !== PLACEHOLDER_VALUE) ctx.defaultedKeys.add(key);
        return out === MISSING_SECRET ? PLACEHOLDER : out;
      }
      return PLACEHOLDER;
    }
    if (v === undefined || v === null || v === '') {
      if (hasDefault) return resolveFallbacks(fallbacks, ctx);
      const kind = kindOf(pathStr);
      if (kind === 'env') {
        addWarning(ctx, `\${env:${pathStr.slice(4)}} is unset; using a placeholder`);
        return PLACEHOLDER;
      }
      if (v !== '' && (kind === 'self' || kind === 'opt' || kind === 'sls' || kind === 'cf' || kind === 's3' || kind === 'param')) {
        addWarning(ctx, `\${${pathStr}} could not be resolved (no value and no default)`);
      } else if (v === undefined && kind === '' && isDocumentPath(pathStr, ctx)) {
        // Bare Trinity paths (custom.x, environment.refs.y.KEY) used to vanish silently, dropping env vars.
        addWarning(ctx, `\${${pathStr}} could not be resolved (no value and no default)`);
      }
      return v;
    }
    return v;
  } catch (e) {
    if (hasDefault && !(e instanceof CircularReference)) return resolveFallbacks(fallbacks, ctx);
    addWarning(ctx, `unresolved \${${expr}}: ${(e as Error).message}`);
    if (e instanceof CircularReference && hasDefault) return resolveFallbacks(fallbacks, ctx);
    return `\${${expr}}`;
  }
}

/** A bare dotted path whose first segment is a top-level key of the document (custom.x, environment.refs.y). */
function isDocumentPath(p: string, ctx: InterpCtx): boolean {
  if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/.test(p)) return false;
  return Object.prototype.hasOwnProperty.call(ctx.root, p.split('.')[0]);
}

function maybeInterp(def: string, ctx: InterpCtx): unknown {
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
  // /aws/reference/secretsmanager/NAME-or-ARN, or a plain parameter path. Serverless v1's `~true` (decrypt) suffix is dropped.
  const noDecrypt = spec.replace(/~(true|false|split)$/, '');
  const ref = noDecrypt.replace(/^\/aws\/reference\/secretsmanager\//, '');
  const name = localSecretName(ctx.stage, secretNameFromArn(ref) ?? ref);
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


/** Secrets promoted from environment.refs that no variable reads; they are not created. Names only. */
export function unreferencedSecrets(ctx: InterpCtx): string[] {
  return [...ctx.secrets.values()].filter((b) => b.source === 'secretsmanager' && !b.referenced && b.keys.size === 0).map((b) => b.name);
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

/**
 * The secret name inside a Secrets Manager ARN, following AWS's documented format
 * `arn:<partition>:secretsmanager:<region>:<account>:secret:<name>-<6 random characters>`.
 * - A full ARN ends in `-` plus exactly 6 alphanumeric characters that Secrets Manager appended; they are dropped.
 * - IAM-style wildcards for that suffix (`<name>-??????`, `<name>-*`, `<name>*`) are dropped too.
 * - Anything after the resource id (ECS `valueFrom` `:json-key:version-stage:version-id`) is ignored.
 * A partial ARN whose own name happens to end in `-` + 6 alphanumerics is ambiguous; AWS documents the
 * same ambiguity and treats it as a full ARN, as we do. Returns undefined for anything that is not such an ARN.
 */
export function secretNameFromArn(raw: string): string | undefined {
  const m = raw.trim().match(/^arn:aws[a-z-]*:secretsmanager:[^:]*:[^:]*:secret:([^:]+)/);
  if (!m) return undefined;
  const id = m[1];
  if (/-\?{6}$/.test(id)) return id.slice(0, -7);
  if (id.endsWith('*')) return id.replace(/-?\*$/, '');
  if (/-[A-Za-z0-9]{6}$/.test(id)) return id.slice(0, -7);
  return id;
}

function secretBagFromRefString(raw: string, ctx: InterpCtx): SecretBag | undefined {
  const s = raw.trim();
  if (!s || s.startsWith('${')) return undefined;
  let leaf = secretNameFromArn(s);
  if (leaf === undefined) {
    if (!/\/aws\/reference\/secretsmanager\//i.test(s)) return undefined;
    const ref = s.replace(/^.*\/aws\/reference\/secretsmanager\//i, '').replace(/~(true|false)$/, '');
    leaf = secretNameFromArn(ref) ?? ref;
  }
  const name = localSecretName(ctx.stage, leaf);
  let bag = ctx.secrets.get(name);
  if (!bag) {
    bag = new SecretBag(name, 'secretsmanager', ctx.fileEnv);
    ctx.secrets.set(name, bag);
  }
  return bag;
}

export function collectSecrets(ctx: InterpCtx): { name: string; keys: string[]; source: string; defaulted: string[] }[] {
  // Secrets promoted from Trinity environment.refs are only created when something reads them
  // (e.g. a prod-only ref is not created for a local deploy).
  return [...ctx.secrets.values()].filter((b) => b.source !== 'secretsmanager' || b.referenced || b.keys.size > 0).map((b) => ({
    name: b.name,
    keys: [...b.keys].sort(),
    source: b.source,
    defaulted: [...b.keys].filter((k) => ctx.defaultedKeys.has(k)).sort(),
  }));
}

export { PLACEHOLDER_VALUE };
