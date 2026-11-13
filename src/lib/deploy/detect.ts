import fs from 'fs';
import path from 'path';
import type { ConfigKind } from './types';

const SKIP = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', '.serverless', 'venv', '.venv', '__pycache__', '.turbo', 'build', 'out', 'vendor', '.yarn']);

export interface DetectedConfig {
  kind: ConfigKind;
  file: string;
  /** Directory that contains the file (packaging root). */
  root: string;
}

const NAMES = new Set(['serverless.yml', 'serverless.yaml', 'trinity.yml', 'trinity.yaml']);

export function detectConfigs(source: string, kind?: ConfigKind): DetectedConfig[] {
  const abs = path.resolve(source);
  if (!fs.existsSync(abs)) throw new Error(`path not found: ${source}`);
  const stat = fs.statSync(abs);
  const files: string[] = [];
  if (stat.isFile()) files.push(abs);
  else walk(abs, files, 0, 6);

  const out: DetectedConfig[] = [];
  for (const file of files) {
    const base = path.basename(file);
    const isSls = base === 'serverless.yml' || base === 'serverless.yaml';
    const isTr = base === 'trinity.yml' || base === 'trinity.yaml' || base.endsWith('.trinity.yml') || base.endsWith('.trinity.yaml');
    if (!isSls && !isTr) continue;
    const k: ConfigKind = isSls ? 'serverless' : 'trinity';
    if (kind && k !== kind) continue;
    out.push({ kind: k, file, root: path.dirname(file) });
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

function walk(dir: string, out: string[], depth: number, max: number) {
  if (depth > max) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1, max);
    else if (e.isFile() && (NAMES.has(e.name) || e.name.endsWith('.trinity.yml') || e.name.endsWith('.trinity.yaml'))) out.push(p);
  }
}
