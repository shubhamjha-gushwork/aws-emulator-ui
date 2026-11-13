import http from 'http';
import https from 'https';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { backendPreset, healthPathFor, loadSettings, type BackendId, type Settings } from './settings';

export interface ResolvedConfig {
  backend: BackendId;
  backendLabel: string;
  endpoint: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  /** Floci accepts any non-empty keys; we always use test/test. */
  credentialSource: 'floci-dummy';
  caLoaded: boolean;
  tlsVerify: boolean;
  runDir: string;
  requestHandler: NodeHttpHandler;
  httpsAgent: https.Agent;
}

export async function resolveConfig(settings?: Settings): Promise<ResolvedConfig> {
  const s = settings ?? (await loadSettings());
  const preset = backendPreset();
  const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };
  const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
  const httpAgent = new http.Agent({ keepAlive: true });
  return {
    backend: 'floci',
    backendLabel: preset.label,
    endpoint: s.endpoint,
    region: s.region,
    credentials,
    credentialSource: 'floci-dummy',
    caLoaded: false,
    tlsVerify: false,
    runDir: '',
    requestHandler: new NodeHttpHandler({
      httpsAgent: agent,
      httpAgent,
      connectionTimeout: 4000,
      // First Lambda/ECS calls may pull a real image.
      requestTimeout: 120000,
    }),
    httpsAgent: agent,
  };
}

/** Common constructor options for every AWS SDK v3 client. */
export function clientOptions(c: ResolvedConfig) {
  return {
    endpoint: c.endpoint,
    region: c.region,
    credentials: c.credentials,
    requestHandler: c.requestHandler,
    maxAttempts: 1,
  };
}

export async function healthCheck(c: ResolvedConfig): Promise<{ ok: boolean; status?: number; ms: number; error?: string }> {
  const started = Date.now();
  const url = new URL(healthPathFor(c), c.endpoint);
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = mod.request(
      url,
      { method: 'GET', timeout: 3000, agent: url.protocol === 'https:' ? c.httpsAgent : undefined },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, ms: Date.now() - started }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, ms: Date.now() - started, error: e.message }));
    req.end();
  });
}
