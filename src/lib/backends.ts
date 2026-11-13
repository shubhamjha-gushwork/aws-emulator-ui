export type BackendId = 'floci';

export interface BackendPreset {
  id: BackendId;
  label: string;
  /** Short line for the top bar and connection card. */
  short: string;
  endpoint: string;
  tlsVerify: boolean;
  healthPath: string;
}

export const FLOCI_DEFAULT_PORT = 4566;
export const FLOCI_HEALTH_PATH = '/_floci/health';
export const FLOCI_ACCOUNT_ID = '000000000000';

function env(name: string): string | undefined {
  // process.env is inlined for the server; on the client these are unset and defaults apply.
  return typeof process !== 'undefined' ? process.env[name] : undefined;
}

export function flociEndpoint(): string {
  return env('FLOCI_ENDPOINT') || env('AWS_ENDPOINT_URL') || `http://127.0.0.1:${env('FLOCI_PORT') || FLOCI_DEFAULT_PORT}`;
}

/** The only supported backend. Endpoint honours FLOCI_ENDPOINT / FLOCI_PORT on the server. */
export function backendPreset(): BackendPreset {
  return {
    id: 'floci',
    label: 'Floci',
    short: 'Floci',
    endpoint: flociEndpoint(),
    tlsVerify: false,
    healthPath: FLOCI_HEALTH_PATH,
  };
}

/** @deprecated use backendPreset(); kept so older imports keep compiling during the cutover. */
export function backendPresets(): Record<BackendId, BackendPreset> {
  return { floci: backendPreset() };
}

export function presetFor(backend?: BackendId): BackendPreset {
  void backend;
  return backendPreset();
}

export function healthPathFor(s?: { backend?: string; endpoint?: string }): string {
  void s;
  return FLOCI_HEALTH_PATH;
}

export function isFloci(s?: { backend?: string; endpoint?: string }): boolean {
  void s;
  return true;
}
