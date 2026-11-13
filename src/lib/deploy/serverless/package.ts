import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import type { ParsedServerless, SlsFunction } from './parse';

export interface PackagedFunction {
  name: string;
  deployedName: string;
  zipPath: string;
  handler: string;
  runtime: string;
}

const SKIP_COPY = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', '.serverless', 'venv', '.venv', '__pycache__', '.turbo', '.yarn']);

export async function packageFunction(parsed: ParsedServerless, fn: SlsFunction): Promise<PackagedFunction> {
  const runtime = pickRuntime(fn.runtime || parsed.runtime || 'nodejs20.x');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-emulator-pkg-'));
  const zipPath = path.join(tmp, `${fn.name}.zip`);
  if (fn.image) throw new Error(`${fn.name}: container-image functions are not packaged (use a zip handler)`);
  if (!fn.handler) throw new Error(`${fn.name}: missing handler`);

  if (runtime.startsWith('python')) {
    await zipPython(parsed, fn, zipPath);
  } else if (parsed.esbuild || looksLikeNode(runtime)) {
    await zipNode(parsed, fn, zipPath);
  } else {
    await zipPython(parsed, fn, zipPath);
  }
  return { name: fn.name, deployedName: fn.deployedName, zipPath, handler: fn.handler, runtime };
}

function looksLikeNode(runtime: string) {
  return runtime.startsWith('nodejs') || runtime.startsWith('provided');
}

export function pickRuntime(runtime: string): string {
  // Prefer the declared runtime; Floci generally accepts current Lambda runtimes.
  return runtime;
}

async function zipNode(parsed: ParsedServerless, fn: SlsFunction, zipPath: string): Promise<void> {
  const entry = resolveHandlerFile(parsed.root, fn.handler!);
  const outDir = path.dirname(zipPath);
  const outFile = path.join(outDir, 'index.js');
  const cfg = parsed.esbuild ?? {};
  const bundled = await bundleWithEsbuild(parsed.root, entry, outFile, cfg);
  if (bundled) {
    fn.handler = 'index.handler';
    zipFiles(outDir, zipPath, ['index.js']);
    return;
  }
  // No esbuild: zip the handler file and a best-effort sibling tree (no node_modules unless small).
  const rel = path.relative(parsed.root, entry);
  zipFiles(parsed.root, zipPath, [rel]);
}

async function bundleWithEsbuild(
  root: string,
  entry: string,
  outFile: string,
  cfg: Record<string, unknown>,
): Promise<boolean> {
  try {
    const esbuild = (await import('esbuild')) as typeof import('esbuild');
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      target: String(cfg.target || 'node20'),
      outfile: outFile,
      minify: Boolean(cfg.minify),
      logLevel: 'error',
      absWorkingDir: root,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Fall through to the native binary if the JS API isn't available.
    if (!msg.includes('Cannot find module') && !msg.includes('Failed to load')) {
      // A real build error — still try the CLI, then rethrow if that also fails.
    }
  }
  const bin = findEsbuild(root);
  if (!bin) return false;
  execFileSync(
    bin,
    [
      entry,
      '--bundle',
      '--platform=node',
      `--target=${String(cfg.target || 'node20')}`,
      `--outfile=${outFile}`,
      ...(cfg.minify ? ['--minify'] : []),
      '--log-level=error',
    ],
    { cwd: root, stdio: 'pipe' },
  );
  return true;
}

async function zipPython(parsed: ParsedServerless, fn: SlsFunction, zipPath: string): Promise<void> {
  // Best-effort: zip source excluding heavy dirs. Dependencies (requirements) are not installed
  // unless a .requirements or existing site-packages is clearly project-local — we skip that to
  // avoid pulling secrets or huge trees.
  const files = listSource(parsed.root, parsed.packagePatterns?.patterns, parsed.packagePatterns?.exclude);
  zipFiles(parsed.root, zipPath, files);
}

function resolveHandlerFile(root: string, handler: string): string {
  const file = handler.replace(/\.[^.]+$/, '');
  const candidates = ['', '.ts', '.js', '.mjs', '.cjs', '.py'].map((ext) => path.join(root, file + ext));
  // handler "a/b.handler" -> a/b.ts; also a/b/index.ts; also handlers/foo.py for "handlers/foo.handler"
  const more = [path.join(root, file, 'index.ts'), path.join(root, file, 'index.js'), path.join(root, `${file}.py`)];
  for (const c of [...candidates, ...more]) if (fs.existsSync(c)) return c;
  throw new Error(`cannot find handler file for ${handler} under ${root}`);
}

function findEsbuild(root: string): string | undefined {
  const require = createRequire(path.join(root, 'package.json'));
  try {
    const p = require.resolve('esbuild/bin/esbuild');
    if (fs.existsSync(p)) return p;
  } catch {
    /* not in the source repo */
  }
  try {
    const here = createRequire(import.meta.url ? path.join(path.dirname(new URL(import.meta.url).pathname), 'package.json') : path.join(process.cwd(), 'package.json'));
    const p = here.resolve('esbuild/bin/esbuild');
    if (fs.existsSync(p)) return p;
  } catch {
    /* not in this repo either */
  }
  const local = path.join(process.cwd(), 'node_modules', 'esbuild', 'bin', 'esbuild');
  if (fs.existsSync(local)) return local;
  return undefined;
}

function listSource(root: string, patterns?: string[], exclude?: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_COPY.has(e.name) || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p);
      if (exclude?.some((x) => match(rel, x))) continue;
      if (e.isDirectory()) walk(p);
      else out.push(rel);
    }
  };
  walk(root);
  if (patterns?.length) return out.filter((f) => patterns.some((p) => match(f, p) || p.startsWith('!')) || true);
  return out.slice(0, 4000);
}

function match(file: string, pattern: string): boolean {
  const pat = pattern.replace(/^!/, '').replace(/\\/g, '/');
  const f = file.replace(/\\/g, '/');
  if (pat.includes('**')) {
    const re = new RegExp('^' + pat.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return re.test(f);
  }
  if (pat.includes('*')) {
    const re = new RegExp('^' + pat.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return re.test(f);
  }
  return f === pat || f.startsWith(pat.replace(/\/$/, '') + '/');
}

function zipFiles(cwd: string, zipPath: string, files: string[]) {
  const list = files.filter((f) => fs.existsSync(path.join(cwd, f)));
  if (!list.length) throw new Error('nothing to zip');
  const chunk = 200;
  for (let i = 0; i < list.length; i += chunk) {
    const part = list.slice(i, i + chunk);
    const args = i === 0 ? ['-q', '-X', zipPath, ...part] : ['-q', '-g', zipPath, ...part];
    execFileSync('zip', args, { cwd, stdio: 'pipe' });
  }
}
