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
  // Function-level package.patterns apply on top of the service-level ones (as with package.individually).
  const svc = parsed.packagePatterns ?? {};
  const files = selectPackageFiles(parsed.root, { ...svc, patterns: [...(svc.patterns ?? []), ...(fn.packagePatterns ?? [])] });
  zipFiles(parsed.root, zipPath, files);
  const size = fs.statSync(zipPath).size;
  if (size > 50 * 1024 * 1024) {
    throw new Error(
      `${fn.name}: package zip is ${Math.round(size / (1024 * 1024))} MB, over Lambda's 50 MB upload limit. ` +
        `Tighten package.patterns / package.exclude so only handler source is included.`,
    );
  }
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

export function selectPackageFiles(
  root: string,
  pkg?: { include?: string[]; exclude?: string[]; patterns?: string[] },
): string[] {
  // Legacy package.exclude / package.include map to patterns the way Serverless Framework does:
  // excludes first, then includes (so an include re-adds what an exclude removed), then patterns.
  const patterns: string[] = [];
  for (const p of pkg?.exclude ?? []) {
    if (!p) continue;
    patterns.push(p.startsWith('!') ? p : `!${p}`);
  }
  for (const p of pkg?.include ?? []) if (p) patterns.push(p);
  for (const p of pkg?.patterns ?? []) if (p) patterns.push(p);
  return listSource(root, patterns);
}

function listSource(root: string, patterns?: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_COPY.has(e.name) || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p);
      if (e.isDirectory()) walk(p);
      else out.push(rel);
    }
  };
  walk(root);
  const filtered = patterns?.length ? out.filter((f) => matchesPackagePatterns(f, patterns)) : out;
  return filtered.slice(0, 4000);
}

/**
 * Serverless Framework package.patterns: every file starts included; patterns are applied in order and
 * the last one that matches decides (`!` excludes, a plain pattern re-includes). So `'!**'` then
 * `'**\/*.py'` packs only .py files, and a file no pattern matches stays included.
 */
export function matchesPackagePatterns(file: string, patterns: string[]): boolean {
  let included = true;
  for (const p of patterns) {
    if (globMatch(file, p)) included = !p.startsWith('!');
  }
  return included;
}

export function globMatch(file: string, pattern: string): boolean {
  const pat = pattern.replace(/^!/, '').replace(/\\/g, '/').replace(/^\.\//, '');
  const f = file.replace(/\\/g, '/');
  if (pat.endsWith('/**')) {
    const prefix = pat.slice(0, -3);
    return f === prefix || f.startsWith(prefix + '/');
  }
  return globToRegExp(pat).test(f);
}

function globToRegExp(pat: string): RegExp {
  let out = '^';
  for (let i = 0; i < pat.length; ) {
    if (pat[i] === '*' && pat[i + 1] === '*' && pat[i + 2] === '/') {
      out += '(?:.*/)?'; // **/ also matches zero directories (**/*.py matches handler.py)
      i += 3;
    } else if (pat[i] === '*' && pat[i + 1] === '*') {
      out += '.*';
      i += 2;
    } else if (pat[i] === '*') {
      out += '[^/]*';
      i += 1;
    } else if (pat[i] === '?') {
      out += '[^/]';
      i += 1;
    } else {
      out += pat[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(out + '$');
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
