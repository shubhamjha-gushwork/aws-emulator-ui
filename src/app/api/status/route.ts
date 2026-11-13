import { healthCheck, resolveConfig } from '@/lib/aws';
import { jsonResponse } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

export async function GET() {
  const cfg = await resolveConfig();
  const health = await healthCheck(cfg);
  return jsonResponse({
    endpoint: cfg.endpoint,
    region: cfg.region,
    caLoaded: cfg.caLoaded,
    tlsVerify: cfg.tlsVerify,
    health,
    checkedAt: new Date().toISOString(),
  });
}
