export type BackendId = 'emulator' | 'floci';

export interface BackendPreset {
  id: BackendId;
  label: string;
  /** Short line for the top bar and connection card. */
  short: string;
  endpoint: string;
  tlsVerify: boolean;
  healthPath: string;
}

export const DEFAULT_PORT = 9297;
export const FLOCI_DEFAULT_PORT = 4566;

function env(name: string): string | undefined {
  // process.env is inlined for the server; on the client these are unset and defaults apply.
  return typeof process !== 'undefined' ? process.env[name] : undefined;
}

function emulatorEndpoint() {
  return env('AWS_EMULATOR_ENDPOINT') || `https://127.0.0.1:${env('AWS_EMULATOR_PORT') || DEFAULT_PORT}`;
}

function flociEndpoint() {
  return env('FLOCI_ENDPOINT') || `http://127.0.0.1:${env('FLOCI_PORT') || FLOCI_DEFAULT_PORT}`;
}

/** Built-in backends. Endpoint values honour AWS_EMULATOR_* / FLOCI_* env overrides on the server. */
export function backendPresets(): Record<BackendId, BackendPreset> {
  return {
    emulator: {
      id: 'emulator',
      label: 'AWS Emulator',
      short: 'AWS Emulator',
      endpoint: emulatorEndpoint(),
      tlsVerify: true,
      healthPath: '/__admin/health',
    },
    floci: {
      id: 'floci',
      label: 'Floci',
      short: 'Floci',
      endpoint: flociEndpoint(),
      tlsVerify: false,
      healthPath: '/_floci/health',
    },
  };
}

export function inferBackend(endpoint: string): BackendId {
  try {
    const u = new URL(endpoint);
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    const floci = new URL(flociEndpoint());
    const flociPort = Number(floci.port || 80);
    if (u.protocol === 'http:' && port === flociPort) return 'floci';
  } catch {
    /* ignore */
  }
  return 'emulator';
}

export function isFloci(s: { backend?: BackendId; endpoint?: string }): boolean {
  return (s.backend ?? inferBackend(s.endpoint || emulatorEndpoint())) === 'floci';
}

export function presetFor(backend: BackendId): BackendPreset {
  return backendPresets()[backend];
}

export function healthPathFor(s: { backend?: BackendId; endpoint?: string }): string {
  return presetFor(s.backend ?? inferBackend(s.endpoint || emulatorEndpoint())).healthPath;
}
