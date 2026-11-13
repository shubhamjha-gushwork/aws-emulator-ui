import { resolveConfig } from '@/lib/aws';
import { normalizeError } from '@/lib/errors';
import { services } from '@/lib/services';
import { InputError, makeCtx, type Params } from '@/lib/services/types';
import { jsonResponse, stripMetadata } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ service: string; action: string }> }) {
  const { service, action } = await params;
  const mod = services[service];
  const fn = mod && Object.prototype.hasOwnProperty.call(mod.actions, action) ? mod.actions[action] : undefined;
  if (!fn) return jsonResponse({ error: { name: 'UnknownAction', message: `Unknown action ${service}.${action}`, notImplemented: false, connection: false } }, 404);
  let body: Params = {};
  try {
    const text = await req.text();
    body = text ? (JSON.parse(text) as Params) : {};
  } catch {
    return jsonResponse({ error: { name: 'InputError', message: 'Body must be JSON', notImplemented: false, connection: false } }, 400);
  }
  try {
    const ctx = makeCtx(await resolveConfig());
    const data = await fn(ctx, body);
    return jsonResponse({ data: stripMetadata(data) });
  } catch (e) {
    const err = normalizeError(e);
    const status = e instanceof InputError ? 400 : err.connection ? 502 : 200;
    // AWS-side errors are returned with 200 + error so the UI can render them inline.
    return jsonResponse({ error: err }, status);
  }
}
