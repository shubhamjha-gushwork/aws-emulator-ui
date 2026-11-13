import { promises as fs } from 'fs';
import path from 'path';
import { backendPreset, type BackendId } from './backends';

export type { BackendId, BackendPreset } from './backends';
export {
  FLOCI_DEFAULT_PORT,
  FLOCI_ACCOUNT_ID,
  backendPreset,
  backendPresets,
  flociEndpoint,
  healthPathFor,
  isFloci,
  presetFor,
} from './backends';

export interface Settings {
  /** Always Floci; kept so older settings.json files still sanitize cleanly. */
  backend: BackendId;
  /** Floci endpoint, e.g. http://127.0.0.1:4566 */
  endpoint: string;
  region: string;
  tlsVerify: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  backend: 'floci',
  endpoint: backendPreset().endpoint,
  region: process.env.AWS_EMULATOR_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
  tlsVerify: false,
};

export function dataDir() {
  return process.env.AWS_EMULATOR_UI_DATA_DIR || path.join(process.cwd(), '.data');
}

const settingsFile = () => path.join(dataDir(), 'settings.json');

const EMULATOR_PORTS = new Set([9297, 443]);

function looksLikeAwsEmulator(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (u.protocol === 'https:' && (port === 9297 || /emulator/i.test(u.hostname))) return true;
    if (port === 9297) return true;
  } catch {
    /* ignore */
  }
  return false;
}

const LOCAL_ENDPOINT_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'host.docker.internal', 'floci']);

/**
 * The endpoint switcher may only point at a local emulator, so the UI server can't be
 * used to send requests to arbitrary hosts. Set AWS_EMULATOR_ALLOW_REMOTE_ENDPOINT=1 to opt out.
 */
export function isLocalEndpointHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOCAL_ENDPOINT_HOSTS.has(h) || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export function sanitizeSettings(input: Partial<Settings>, base: Settings = DEFAULT_SETTINGS): Settings {
  const s: Settings = { ...base, backend: 'floci', tlsVerify: false };
  const preset = backendPreset();
  // Migrating off AWS Emulator: a saved 9297 / https emulator endpoint becomes the Floci default.
  if (!s.endpoint || looksLikeAwsEmulator(s.endpoint)) s.endpoint = preset.endpoint;
  if (typeof input.endpoint === 'string' && input.endpoint.trim()) {
    const url = new URL(input.endpoint.trim()); // throws on garbage
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Endpoint must be http(s)');
    if (!isLocalEndpointHost(url.hostname) && process.env.AWS_EMULATOR_ALLOW_REMOTE_ENDPOINT !== '1') {
      throw new Error('Endpoint must be a local host (localhost / 127.0.0.1); set AWS_EMULATOR_ALLOW_REMOTE_ENDPOINT=1 to allow others');
    }
    const origin = url.origin;
    s.endpoint = looksLikeAwsEmulator(origin) ? preset.endpoint : origin;
  }
  if (typeof input.region === 'string' && /^[a-z]{2}(-[a-z]+)+\-\d$/.test(input.region.trim())) s.region = input.region.trim();
  s.backend = 'floci';
  s.tlsVerify = false;
  return s;
}

/**
 * Credentials are never stored. Floci accepts any non-empty keys (we use test/test).
 * Only endpoint and region are persisted; saving rewrites the file, which also drops
 * keys or AWS Emulator fields left there by older versions.
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

// Silence unused in case a caller still references the old port set.
void EMULATOR_PORTS;
