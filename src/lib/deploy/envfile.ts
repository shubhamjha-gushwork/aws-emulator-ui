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
 * Parse a dotenv-style file: KEY=VALUE, optional `export `, comments, single/double/backtick quotes,
 * quoted values spanning several lines (e.g. PEM keys), and `# comments` after a value.
 * Does not interpolate $(...) or ${VAR} inside values (avoids surprise expansion).
 */
export function parseEnvContent(content: string): EnvMap {
  const out: EnvMap = {};
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let i = 0;
  const n = text.length;
  const skipLine = () => {
    while (i < n && text[i] !== '\n') i++;
    i++;
  };
  while (i < n) {
    // leading whitespace
    while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
    if (i >= n) break;
    if (text[i] === '\n') {
      i++;
      continue;
    }
    if (text[i] === '#') {
      skipLine();
      continue;
    }
    let lineEnd = text.indexOf('\n', i);
    if (lineEnd < 0) lineEnd = n;
    let head = text.slice(i, lineEnd);
    const exp = head.match(/^export[ \t]+/);
    if (exp) {
      i += exp[0].length;
      head = head.slice(exp[0].length);
    }
    const eq = head.indexOf('=');
    const key = eq > 0 ? head.slice(0, eq).trim() : '';
    if (!key || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
      skipLine();
      continue;
    }
    i += eq + 1;
    while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
    const q = text[i];
    if (q === '"' || q === "'" || q === '`') {
      // Quoted: runs to the matching unescaped quote, possibly across lines.
      let j = i + 1;
      let raw = '';
      let closed = false;
      while (j < n) {
        const c = text[j];
        if (c === '\\' && q === '"' && j + 1 < n) {
          raw += c + text[j + 1];
          j += 2;
          continue;
        }
        if (c === q) {
          closed = true;
          break;
        }
        raw += c;
        j++;
      }
      if (!closed) {
        // Unterminated quote: treat the rest of the line literally rather than swallowing the file.
        out[key] = text.slice(i, lineEnd).trim();
        i = lineEnd + 1;
        continue;
      }
      out[key] = q === '"'
        ? raw.replace(/\\(n|r|t|"|\\)/g, (_m, ch: string) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[ch] as string)
        : raw;
      i = j + 1;
      skipLine(); // ignore anything after the closing quote (e.g. a comment)
      continue;
    }
    let value = text.slice(i, lineEnd);
    const hash = value.search(/[ \t]#/);
    if (hash >= 0) value = value.slice(0, hash);
    out[key] = value.trim();
    i = lineEnd + 1;
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

export function classifyKeys(
  keys: string[],
  fileEnv: EnvMap,
  defaultedNames?: string[],
): { filled: string[]; defaulted: string[]; missing: string[] } {
  const filled: string[] = [];
  const defaulted: string[] = [];
  const missing: string[] = [];
  const defs = new Set(defaultedNames ?? []);
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(fileEnv, k) && fileEnv[k] !== '') filled.push(k);
    else if (defs.has(k)) defaulted.push(k);
    else missing.push(k);
  }
  return { filled, defaulted, missing };
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
