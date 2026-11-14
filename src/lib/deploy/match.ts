import fs from 'fs';
import path from 'path';
import type { DeployManifest } from './types';

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Which recorded deploys a destroy target means. An existing path matches deploys whose config lives
 * under it (symlinks resolved); otherwise an exact id, or an id prefix that matches exactly one deploy.
 * --stage / --region / --kind narrow the match so `destroy . --stage a` leaves stage b alone.
 */
export function matchDeployments(all: DeployManifest[], target: string, filter: { stage?: string; region?: string; kind?: string } = {}): DeployManifest[] {
  const narrowed = all.filter((m) => (!filter.stage || m.stage === filter.stage) && (!filter.region || m.region === filter.region) && (!filter.kind || m.kind === filter.kind));
  if (fs.existsSync(target)) {
    const abs = realpathSafe(target);
    const hits = narrowed.filter((m) => {
      const src = realpathSafe(m.source);
      return src === abs || src.startsWith(abs + path.sep);
    });
    // A path with nothing recorded under it: nothing to do (destroy stays idempotent).
    if (hits.length || !all.some((m) => m.id === target)) return hits;
  }
  const exact = narrowed.filter((m) => m.id === target);
  if (exact.length) return exact;
  const prefix = narrowed.filter((m) => m.id.startsWith(target));
  if (prefix.length > 1) throw new Error(`${target} matches ${prefix.length} deployments (${prefix.map((m) => m.id).join(', ')}); use the full id`);
  if (!prefix.length) throw new Error(`no recorded deployment matches ${target}${filter.stage ? ` (stage ${filter.stage})` : ''} (see aws-emulator list)`);
  return prefix;
}

