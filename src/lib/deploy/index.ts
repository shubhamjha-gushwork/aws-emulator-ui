import path from 'path';
import { detectConfigs, type DetectedConfig } from './detect';
import { makeClients } from './client';
import { readManifest, writeManifest } from './state';
import { manifestId, type DeployManifest, type DeployOptions, type Plan } from './types';
import { parseServerlessFile, planServerless } from './serverless/parse';
import { applyServerless } from './serverless/apply';
import { parseTrinityFile, planTrinity } from './trinity/parse';
import { applyTrinity } from './trinity/apply';
export { destroyManifest, destroyById } from './destroy';

export * from './types';
export { detectConfigs } from './detect';
export { listManifests, readManifest, deleteManifest, deploymentsDir } from './state';
export { collectSecrets } from './interpolate';

export interface RunResult {
  configs: DetectedConfig[];
  plans: Plan[];
  manifests: DeployManifest[];
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
  const clients = dry ? undefined : makeClients(opts);
  const plans: Plan[] = [];
  const manifests: DeployManifest[] = [];
  for (const cfg of configs) {
    const sourceLabel = path.resolve(cfg.file);
    if (cfg.kind === 'serverless') {
      const parsed = parseServerlessFile(cfg.file, { stage: opts.stage, region: opts.region });
      if (dry) {
        plans.push(planServerless(parsed));
        continue;
      }
      const id = manifestId(parsed.service, parsed.stage, 'serverless', path.relative(opts.source, cfg.file) || parsed.service);
      const existing = readManifest(id);
      const { plan, manifest } = await applyServerless(clients!, parsed, { dryRun: false, id, source: sourceLabel });
      if (manifest) {
        if (existing) manifest.createdAt = existing.createdAt;
        writeManifest(manifest);
        manifests.push(manifest);
      }
      plans.push(plan);
    } else {
      const parsed = parseTrinityFile(cfg.file, { stage: opts.stage, region: opts.region });
      if (dry) {
        plans.push(planTrinity(parsed));
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
      });
      if (manifest) {
        if (existing) manifest.createdAt = existing.createdAt;
        writeManifest(manifest);
        manifests.push(manifest);
      }
      plans.push(plan);
    }
  }
  return { configs, plans, manifests };
}


