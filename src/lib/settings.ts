import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

export type CredentialsMode = 'auto' | 'manual';

export interface Settings {
  /** Emulator endpoint, e.g. https://127.0.0.1:9297 */
  endpoint: string;
  region: string;
  /**
   * auto: read the per-run keys and CA the emulator writes to ~/.aws/emulator/<port>/
   * manual: use the keys below (e.g. dummy keys when the emulator runs with --auth off)
   */
  credentialsMode: CredentialsMode;
  accessKeyId: string;
  secretAccessKey: string;
  /** Verify the emulator's TLS certificate against its generated ca.pem. */
  tlsVerify: boolean;
}

export const DEFAULT_PORT = 9297;

export const DEFAULT_SETTINGS: Settings = {
  endpoint: process.env.AWS_EMULATOR_ENDPOINT || `https://127.0.0.1:${DEFAULT_PORT}`,
  region: process.env.AWS_EMULATOR_REGION || 'us-east-1',
  credentialsMode: 'auto',
  accessKeyId: 'test',
  secretAccessKey: 'test',
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
  if (typeof input.endpoint === 'string' && input.endpoint.trim()) {
    const url = new URL(input.endpoint.trim()); // throws on garbage
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Endpoint must be http(s)');
    s.endpoint = url.origin;
  }
  if (typeof input.region === 'string' && /^[a-z]{2}(-[a-z]+)+-\d$/.test(input.region.trim())) s.region = input.region.trim();
  if (input.credentialsMode === 'auto' || input.credentialsMode === 'manual') s.credentialsMode = input.credentialsMode;
  if (typeof input.accessKeyId === 'string' && input.accessKeyId) s.accessKeyId = input.accessKeyId;
  if (typeof input.secretAccessKey === 'string' && input.secretAccessKey) s.secretAccessKey = input.secretAccessKey;
  if (typeof input.tlsVerify === 'boolean') s.tlsVerify = input.tlsVerify;
  return s;
}

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
