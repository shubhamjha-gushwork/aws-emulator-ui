import http from 'http';
import https from 'https';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { readRunFiles } from './emulator-files';
import { healthPathFor, isFloci, loadSettings, presetFor, type BackendId, type Settings } from './settings';

export interface ResolvedConfig {
  backend: BackendId;
  backendLabel: string;
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
  const backend: BackendId = s.backend ?? (isFloci(s) ? 'floci' : 'emulator');
  const preset = presetFor(backend);
  const floci = backend === 'floci';
  // Floci accepts any non-empty keys (test/test). AWS Emulator uses the per-run
  // files under ~/.aws/emulator/<port>/, with the same dummy pair as a fallback.
  const run = floci ? { dir: '', credentials: undefined as ResolvedConfig['credentials'] | undefined, ca: undefined as string | undefined } : await readRunFiles(s.endpoint);
  const credentials = run.credentials ?? { accessKeyId: 'test', secretAccessKey: 'test' };
  const credentialSource: ResolvedConfig['credentialSource'] = run.credentials ? 'emulator-run-files' : 'fallback-dummy';
  const agent = new https.Agent({
    keepAlive: true,
    ca: s.tlsVerify && run.ca ? run.ca : undefined,
    rejectUnauthorized: floci ? false : s.tlsVerify,
  });
  const httpAgent = new http.Agent({ keepAlive: true });
  return {
    backend,
    backendLabel: preset.label,
    endpoint: s.endpoint,
    region: s.region,
    credentials,
    credentialSource,
    caLoaded: Boolean(run.ca),
    tlsVerify: s.tlsVerify,
    runDir: run.dir,
    requestHandler: new NodeHttpHandler({
      httpsAgent: agent,
      httpAgent,
      connectionTimeout: 4000,
      // Floci's first Lambda/ECS calls may pull a real image.
      requestTimeout: floci ? 120000 : 30000,
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
