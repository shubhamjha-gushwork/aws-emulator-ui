import path from 'path';
import { detectConfigs, type DetectedConfig } from './detect';
import { makeClients } from './client';
import { readManifest, writeManifest } from './state';
import { manifestId, type DeployManifest, type DeployOptions, type Plan } from './types';
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
  const clients = dry ? undefined : makeClients(opts);
  const plans: Plan[] = [];
  const manifests: DeployManifest[] = [];
  for (const cfg of configs) {
    const sourceLabel = path.resolve(cfg.file);
    if (cfg.kind === 'serverless') {
      const parsed = parseServerlessFile(cfg.file, { stage: opts.stage, region: opts.region, env, fileEnv: loaded.env });
      if (dry) {
        plans.push(annotatePlan(planServerless(parsed, { noRun: opts.noRun }), loaded.env));
        continue;
      }
      const id = manifestId(parsed.service, parsed.stage, 'serverless', path.relative(opts.source, cfg.file) || parsed.service);
      const existing = readManifest(id);
      const { plan, manifest } = await applyServerless(clients!, parsed, { dryRun: false, id, source: sourceLabel, fileEnv: loaded.env, noRun: opts.noRun });
      if (manifest) {
        if (existing) manifest.createdAt = existing.createdAt;
        writeManifest(manifest);
        manifests.push(manifest);
      }
      plans.push(annotatePlan(plan, loaded.env));
    } else {
      const parsed = parseTrinityFile(cfg.file, { stage: opts.stage, region: opts.region, env, fileEnv: loaded.env });
      if (dry) {
        plans.push(annotatePlan(planTrinity(parsed, { noRun: opts.noRun }), loaded.env));
        continue;
      }
      const id = manifestId(parsed.name, parsed.stage, 'trinity', path.relative(opts.source, cfg.file) || parsed.name);
      const existing = readManifest(id);
      const { plan, manifest } = await applyTrinity(clients!, parsed, {
        dryRun: false,
        noBuild: opts.noBuild,
        desiredCount: opts.desiredCount,
        id,
        source: sourceLabel,
        fileEnv: loaded.env,
        noRun: opts.noRun,
      });
      if (manifest) {
        if (existing) manifest.createdAt = existing.createdAt;
        writeManifest(manifest);
        manifests.push(manifest);
      }
      plans.push(annotatePlan(plan, loaded.env));
    }
  }
  return { configs, plans, manifests, envFile: loaded.path };
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
      const parsed = parseServerlessFile(cfg.file, { stage: opts.stage, region: opts.region, env, fileEnv: loaded.env });
      plans.push(annotatePlan(planServerless(parsed, { noRun: opts.noRun }), loaded.env));
    } else {
      const parsed = parseTrinityFile(cfg.file, { stage: opts.stage, region: opts.region, env, fileEnv: loaded.env });
      plans.push(annotatePlan(planTrinity(parsed, { noRun: opts.noRun }), loaded.env));
    }
  }
  return { configs, plans, manifests: [], envFile: loaded.path };
}
