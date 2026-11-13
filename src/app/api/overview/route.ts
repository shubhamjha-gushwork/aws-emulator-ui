import { resolveConfig } from '@/lib/aws';
import { services } from '@/lib/services';
import { makeCtx } from '@/lib/services/types';
import { jsonResponse } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

export async function GET() {
  const ctx = makeCtx(await resolveConfig());
  const entries = await Promise.all(
    Object.entries(services).map(async ([id, mod]) => {
      const started = Date.now();
      const counts = await mod.counts(ctx).catch(() => [{ label: 'Resources', value: -1 }]);
      return [id, { counts, ms: Date.now() - started }] as const;
    }),
  );
  return jsonResponse(Object.fromEntries(entries));
}
