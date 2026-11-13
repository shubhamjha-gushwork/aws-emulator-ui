import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DeployManifest } from './types';

export function deploymentsDir(): string {
  return process.env.AWS_EMULATOR_DEPLOYMENTS_DIR || path.join(os.homedir(), '.aws-emulator', 'deployments');
}

function fileFor(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return path.join(deploymentsDir(), `${safe}.json`);
}

export function listManifests(): DeployManifest[] {
  const dir = deploymentsDir();
  if (!fs.existsSync(dir)) return [];
  const out: DeployManifest[] = [];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as DeployManifest);
    } catch {
      /* skip corrupt */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function readManifest(id: string): DeployManifest | undefined {
  const f = fileFor(id);
  if (!fs.existsSync(f)) return undefined;
  return JSON.parse(fs.readFileSync(f, 'utf8')) as DeployManifest;
}

export function writeManifest(m: DeployManifest): void {
  const dir = deploymentsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(fileFor(m.id), JSON.stringify(m, null, 2), { mode: 0o600 });
}

export function deleteManifest(id: string): void {
  const f = fileFor(id);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
