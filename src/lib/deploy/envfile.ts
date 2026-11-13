import fs from 'fs';
import path from 'path';
import { PLACEHOLDER_VALUE } from './types';

const PLACEHOLDER = 'PLACEHOLDER';

/** Never print this. Use mask() or key names only in logs. */
export type EnvMap = Record<string, string>;

export function mask(value?: string): string {
  void value;
  return '***';
}

/**
 * Parse a dotenv-style file: KEY=VALUE, optional `export `, comments, quotes.
 * Does not interpolate $(...) or ${VAR} inside values (avoids surprise expansion).
 */
export function parseEnvContent(content: string): EnvMap {
  const out: EnvMap = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      const q = value[0];
      value = value.slice(1, -1);
      if (q === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

export function parseEnvFile(file: string): EnvMap {
  return parseEnvContent(fs.readFileSync(file, 'utf8'));
}

/** Default: <dir>/.env.local then <dir>/.env. `source` may be a file or a directory. */
export function findDefaultEnvFile(source: string): string | undefined {
  const dir = fs.existsSync(source) && fs.statSync(source).isFile() ? path.dirname(source) : source;
  for (const name of ['.env.local', '.env']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return undefined;
}

export function resolveEnvFile(source: string, explicit?: string): string | undefined {
  if (explicit) {
    const p = path.isAbsolute(explicit) ? explicit : path.resolve(process.cwd(), explicit);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`env file not found: ${explicit}`);
    return p;
  }
  return findDefaultEnvFile(source);
}

export function buildSecretPayload(keys: string[], fileEnv: EnvMap): { secretString: string; filled: string[]; missing: string[] } {
  const use = keys.length ? keys : ['VALUE'];
  const filled: string[] = [];
  const missing: string[] = [];
  const obj: Record<string, string> = {};
  for (const k of use) {
    if (Object.prototype.hasOwnProperty.call(fileEnv, k)) {
      obj[k] = fileEnv[k];
      filled.push(k);
    } else {
      obj[k] = PLACEHOLDER_VALUE;
      missing.push(k);
    }
  }
  return { secretString: JSON.stringify(obj, null, 2), filled, missing };
}

/** Replace PLACEHOLDER env vars in place when the env file has the same key. Returns filled key names. */
export function fillPlaceholderEnv(vars: Record<string, string>, fileEnv: EnvMap): string[] {
  const filled: string[] = [];
  for (const [k, v] of Object.entries(vars)) {
    if ((v === PLACEHOLDER || v === PLACEHOLDER_VALUE) && Object.prototype.hasOwnProperty.call(fileEnv, k)) {
      vars[k] = fileEnv[k];
      filled.push(k);
    }
  }
  return filled;
}

export function classifyKeys(keys: string[], fileEnv: EnvMap): { filled: string[]; missing: string[] } {
  const filled: string[] = [];
  const missing: string[] = [];
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(fileEnv, k)) filled.push(k);
    else missing.push(k);
  }
  return { filled, missing };
}

export function renderEnvExample(keys: string[]): string {
  const unique = [...new Set(keys)].sort();
  const lines = [
    '# Keys referenced by serverless.yml / trinity.yml.',
    '# Fill in values locally. This file lists names only — never commit real values.',
    '',
    ...unique.map((k) => `${k}=`),
    '',
  ];
  return lines.join('\n');
}
