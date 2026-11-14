import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { detectConfigs, type DetectedConfig } from './detect';
import { makeClients, type DeployClients } from './client';
import { dedupeResources, destroyResources, resourceKey, splitShared } from './destroy';
import { listManifests, readManifest, writeManifest } from './state';
import { manifestId, type ConfigKind, type DeployManifest, type DeployOptions, type ManifestResource, type Plan } from './types';
import { parseServerlessFile, planServerless } from './serverless/parse';
import { applyServerless } from './serverless/apply';
import { parseTrinityFile, planTrinity } from './trinity/parse';
import { applyTrinity } from './trinity/apply';
import { classifyKeys, parseEnvFile, resolveEnvFile, type EnvMap } from './envfile';

export { destroyManifest, destroyById } from './destroy';

export * from './types';
export { detectConfigs } from './detect';
export { listManifests, readManifest, deleteManifest, deploymentsDir } from './state';
export { collectSecrets } from './interpolate';

export interface RunResult {
  configs: DetectedConfig[];
  plans: Plan[];
  manifests: DeployManifest[];
  envFile?: string;
}

export function loadFileEnv(opts: Pick<DeployOptions, 'source' | 'envFile'>): { path?: string; env: EnvMap } {
  const pathName = resolveEnvFile(opts.source, opts.envFile);
  if (!pathName) return { env: {} };
  return { path: pathName, env: parseEnvFile(pathName) };
}

export function annotatePlan(plan: Plan, fileEnv: EnvMap): Plan {
  for (const p of plan.placeholders) {
    const { filled, defaulted, missing } = classifyKeys(p.keys, fileEnv, p.defaulted);
    p.filled = filled;
    p.defaulted = defaulted;
    p.missing = missing;
  }
  return plan;
}

export async function planAll(opts: DeployOptions): Promise<RunResult> {
  return run(opts, true);
}

export async function deployAll(opts: DeployOptions): Promise<RunResult> {
  return run(opts, opts.dryRun);
}

async function run(opts: DeployOptions, dry: boolean): Promise<RunResult> {
  const configs = detectConfigs(opts.source, opts.kind);
  if (!configs.length) throw new Error(`no serverless.yml or trinity.yml found under ${opts.source}`);
  const loaded = loadFileEnv(opts);
  const env = { ...process.env, ...loaded.env };
  const plans: Plan[] = [];
  const manifests: DeployManifest[] = [];
  const parseOpts = { stage: opts.stage, region: opts.region, env, fileEnv: loaded.env, regionFromFlag: opts.regionFromFlag };
  for (const cfg of configs) {
    const sourceLabel = path.resolve(cfg.file);
    if (cfg.kind === 'serverless') {
      const parsed = parseServerlessFile(cfg.file, parseOpts);
      if (dry) {
        plans.push(annotatePlan(planServerless(parsed, { noRun: opts.noRun }), loaded.env));
        continue;
      }
      const id = resolveManifestId('serverless', parsed.service, parsed.stage, parsed.region, cfg.file, opts.source);
      const existing = readManifest(id);
      const clients = makeClients({ endpoint: opts.endpoint, region: parsed.region });
      const tracked = checkpointed({ id, kind: 'serverless', service: parsed.service, stage: parsed.stage, region: parsed.region, source: cfg.file }, existing);
      const { plan, manifest } = await withPartialHint(id, tracked, () =>
        applyServerless(clients, parsed, { dryRun: false, id, source: sourceLabel, fileEnv: loaded.env, noRun: opts.noRun, resources: tracked, previous: existing?.resources }));
      if (manifest) manifests.push(await finalize(clients, manifest, existing, plan, parsed.warnings));
      plans.push(annotatePlan(plan, loaded.env));
    } else {
      const parsed = parseTrinityFile(cfg.file, parseOpts);
      if (dry) {
        plans.push(annotatePlan(planTrinity(parsed, { noRun: opts.noRun, desiredCount: opts.desiredCount }), loaded.env));
        continue;
      }
      const id = resolveManifestId('trinity', parsed.name, parsed.stage, parsed.region, cfg.file, opts.source);
      const existing = readManifest(id);
      const clients = makeClients({ endpoint: opts.endpoint, region: parsed.region });
      const tracked = checkpointed({ id, kind: 'trinity', service: parsed.name, stage: parsed.stage, region: parsed.region, source: cfg.file }, existing);
      const { plan, manifest } = await withPartialHint(id, tracked, () =>
        applyTrinity(clients, parsed, {
          dryRun: false,
          noBuild: opts.noBuild,
          desiredCount: opts.desiredCount,
          id,
          source: sourceLabel,
          fileEnv: loaded.env,
          noRun: opts.noRun,
          resources: tracked,
        }));
      if (manifest) manifests.push(await finalize(clients, manifest, existing, plan, parsed.warnings));
      plans.push(annotatePlan(plan, loaded.env));
    }
  }
  return { configs, plans, manifests, envFile: loaded.path };
}

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * One manifest per (config file, stage, region). Reuses the id of an earlier deploy of the same file
 * however it was addressed (repo dir, the file itself, a symlink, another cwd); otherwise derives a new one.
 */
export function resolveManifestId(kind: ConfigKind, service: string, stage: string, region: string, file: string, source: string): string {
  const real = realpathSafe(file);
  const same = listManifests().find((m) => m.kind === kind && m.stage === stage && (m.region || DEFAULT_REGION) === region && realpathSafe(m.source) === real);
  if (same) return same.id;
  let id = manifestId(service, stage, kind, path.relative(source, file) || path.basename(file));
  if (region !== DEFAULT_REGION) id += `-${region}`;
  const clash = readManifest(id);
  if (clash && realpathSafe(clash.source) !== real) id += `-${createHash('sha1').update(real).digest('hex').slice(0, 6)}`;
  return id;
}

const DEFAULT_REGION = 'us-east-1';

/** An array that persists a partial manifest on every push, so a crash, Ctrl-C or kill mid-deploy stays destroyable. */
function checkpointed(base: Pick<DeployManifest, 'id' | 'kind' | 'service' | 'stage' | 'region' | 'source'>, existing?: DeployManifest): ManifestResource[] {
  const arr: ManifestResource[] = [];
  const push = arr.push.bind(arr);
  const createdAt = existing?.createdAt ?? new Date().toISOString();
  arr.push = (...items: ManifestResource[]) => {
    const n = push(...items);
    writeManifest({
      ...base,
      createdAt,
      updatedAt: new Date().toISOString(),
      resources: dedupeResources([...(existing?.resources ?? []), ...arr]),
      placeholders: existing?.placeholders ?? [],
      warnings: ['deploy did not finish — rerun deploy to complete it, or destroy to remove what was created'],
    });
    return n;
  };
  return arr;
}

async function withPartialHint<T>(id: string, tracked: ManifestResource[], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as Error;
    if (tracked.length) err.message += ` — ${tracked.length} resource(s) created before the failure are recorded as ${id}; rerun deploy to finish or destroy to clean up`;
    throw err;
  }
}

/** Failures during this deploy only; parse-time notes like "could not be resolved" must not block pruning. */
export function deployHadFailures(planWarnings: string[], parseWarnings: string[]): boolean {
  const parsed = new Set(parseWarnings);
  return planWarnings.some((w) => !parsed.has(w) && /failed|could not/i.test(w));
}

/** Dedupe, remove what a redeploy no longer creates (like CloudFormation), then write the final manifest. */
async function finalize(clients: DeployClients, manifest: DeployManifest, existing: DeployManifest | undefined, plan: Plan, parseWarnings: string[] = []): Promise<DeployManifest> {
  manifest.resources = dedupeResources(manifest.resources);
  if (existing) {
    manifest.createdAt = existing.createdAt;
    const keep = new Set(manifest.resources.map(resourceKey));
    const allStale = dedupeResources(existing.resources).filter((r) => !keep.has(resourceKey(r)));
    // Resources another deployment also records (a shared secret, cluster, …) are dropped from this manifest, not deleted.
    const { own: stale, shared } = splitShared(allStale, manifest.id, manifest.region);
    if (shared.length) plan.warnings.push(`left ${shared.length} resource(s) no longer in this config because another deployment uses them: ${shared.map((s) => s.resource.name).join(', ')}`);
    // Only failures during this deploy count; parse-time notes like "could not be resolved" must not block pruning.
    const hadFailures = deployHadFailures(plan.warnings, parseWarnings);
    if (stale.length && hadFailures) {
      plan.warnings.push(`kept ${stale.length} resource(s) from the previous deploy because some resources failed this time: ${stale.map((r) => r.name).join(', ')}`);
      manifest.resources.push(...stale);
    } else if (stale.length) {
      const r = await destroyResources(clients, stale);
      if (r.ok.length) plan.warnings.push(`removed ${r.ok.length} resource(s) no longer in the config: ${r.ok.join(', ')}`);
      const failedNames = new Set(r.failed.map((f) => f.name));
      manifest.resources.push(...stale.filter((s) => failedNames.has(`${s.kind}:${s.name}`)));
      for (const f of r.failed) plan.warnings.push(`could not remove ${f.name}: ${f.error}`);
    }
  }
  manifest.warnings = [...new Set(manifest.warnings.concat(plan.warnings))];
  writeManifest(manifest);
  return manifest;
}

export function inspectSecrets(opts: DeployOptions): RunResult {
  return {
    ...runSyncPlan(opts),
  };
}

function runSyncPlan(opts: DeployOptions): RunResult {
  const configs = detectConfigs(opts.source, opts.kind);
  if (!configs.length) throw new Error(`no serverless.yml or trinity.yml found under ${opts.source}`);
  const loaded = loadFileEnv(opts);
  const env = { ...process.env, ...loaded.env };
  const plans: Plan[] = [];
  for (const cfg of configs) {
    if (cfg.kind === 'serverless') {
      const parsed = parseServerlessFile(cfg.file, { stage: opts.stage, region: opts.region, env, fileEnv: loaded.env, regionFromFlag: opts.regionFromFlag });
      plans.push(annotatePlan(planServerless(parsed, { noRun: opts.noRun }), loaded.env));
    } else {
      const parsed = parseTrinityFile(cfg.file, { stage: opts.stage, region: opts.region, env, fileEnv: loaded.env, regionFromFlag: opts.regionFromFlag });
      plans.push(annotatePlan(planTrinity(parsed, { noRun: opts.noRun, desiredCount: opts.desiredCount }), loaded.env));
    }
  }
  return { configs, plans, manifests: [], envFile: loaded.path };
}
