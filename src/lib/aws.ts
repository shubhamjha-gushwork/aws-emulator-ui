import https from 'https';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { readRunFiles } from './emulator-files';
import { loadSettings, type Settings } from './settings';

export interface ResolvedConfig {
  endpoint: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  /** Where the SigV4 keys came from (server-side only; not shown in the UI). */
  credentialSource: 'emulator-run-files' | 'fallback-dummy';
  caLoaded: boolean;
  tlsVerify: boolean;
  runDir: string;
  requestHandler: NodeHttpHandler;
  httpsAgent: https.Agent;
}

export async function resolveConfig(settings?: Settings): Promise<ResolvedConfig> {
  const s = settings ?? (await loadSettings());
  const run = await readRunFiles(s.endpoint);
  // Always the emulator's own per-run keys; dummy keys only if they're missing (e.g. --auth off).
  const credentials = run.credentials ?? { accessKeyId: 'test', secretAccessKey: 'test' };
  const credentialSource: ResolvedConfig['credentialSource'] = run.credentials ? 'emulator-run-files' : 'fallback-dummy';
  const agent = new https.Agent({
    keepAlive: true,
    ca: s.tlsVerify && run.ca ? run.ca : undefined,
    rejectUnauthorized: s.tlsVerify,
  });
  return {
    endpoint: s.endpoint,
    region: s.region,
    credentials,
    credentialSource,
    caLoaded: Boolean(run.ca),
    tlsVerify: s.tlsVerify,
    runDir: run.dir,
    requestHandler: new NodeHttpHandler({ httpsAgent: agent, connectionTimeout: 4000, requestTimeout: 30000 }),
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
  const url = new URL('/__admin/health', c.endpoint);
  const mod = url.protocol === 'https:' ? https : await import('http');
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
