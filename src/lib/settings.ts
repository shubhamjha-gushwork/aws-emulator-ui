import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  inferBackend,
  presetFor,
  type BackendId,
} from './backends';

export type { BackendId, BackendPreset } from './backends';
export {
  DEFAULT_PORT,
  FLOCI_DEFAULT_PORT,
  backendPresets,
  healthPathFor,
  inferBackend,
  isFloci,
  presetFor,
} from './backends';

export interface Settings {
  /** Which local AWS backend the UI talks to. */
  backend: BackendId;
  /** Emulator endpoint, e.g. https://127.0.0.1:9297 */
  endpoint: string;
  region: string;
  /** Verify the emulator's TLS certificate against its generated ca.pem. */
  tlsVerify: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  backend: 'emulator',
  endpoint: presetFor('emulator').endpoint,
  region: process.env.AWS_EMULATOR_REGION || 'us-east-1',
  tlsVerify: true,
};

export function dataDir() {
  return process.env.AWS_EMULATOR_UI_DATA_DIR || path.join(process.cwd(), '.data');
}

export function emulatorHome() {
  return process.env.AWS_EMULATOR_HOME || path.join(os.homedir(), '.aws', 'emulator');
}

const settingsFile = () => path.join(dataDir(), 'settings.json');

export function sanitizeSettings(input: Partial<Settings>, base: Settings = DEFAULT_SETTINGS): Settings {
  const s: Settings = { ...base };
  if (input.backend === 'emulator' || input.backend === 'floci') {
    const p = presetFor(input.backend);
    s.backend = p.id;
    s.endpoint = p.endpoint;
    s.tlsVerify = p.tlsVerify;
  }
  // An explicit endpoint (legacy files, tests, custom ports) wins over the preset
  // only when the caller didn't just switch backend in the same payload.
  if (typeof input.endpoint === 'string' && input.endpoint.trim() && input.backend === undefined) {
    const url = new URL(input.endpoint.trim()); // throws on garbage
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Endpoint must be http(s)');
    s.endpoint = url.origin;
    s.backend = inferBackend(s.endpoint);
    if (s.backend === 'floci') s.tlsVerify = false;
  }
  if (typeof input.region === 'string' && /^[a-z]{2}(-[a-z]+)+\-\d$/.test(input.region.trim())) s.region = input.region.trim();
  if (typeof input.tlsVerify === 'boolean' && input.backend === undefined) s.tlsVerify = input.tlsVerify;
  if (s.backend !== 'emulator' && s.backend !== 'floci') s.backend = inferBackend(s.endpoint);
  return s;
}

/**
 * Credentials are never stored: AWS Emulator uses the per-run keys it writes to
 * ~/.aws/emulator/<port>/ (see emulator-files.ts); Floci uses the dummy test/test pair.
 * Only these fields are persisted, and saving rewrites the file, which also drops keys
 * left there by older versions.
 */
export async function loadSettings(): Promise<Settings> {
  try {
    const raw = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
    return sanitizeSettings(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(input: Partial<Settings>): Promise<Settings> {
  const next = sanitizeSettings(input, await loadSettings());
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

export function endpointPort(endpoint: string): number {
  const u = new URL(endpoint);
  return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
}
