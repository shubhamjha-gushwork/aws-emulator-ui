import { destroyById } from '@/lib/deploy/destroy';
import { readManifest } from '@/lib/deploy/state';
import { loadSettings } from '@/lib/settings';
import { jsonResponse } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const m = readManifest(id);
  if (!m) return jsonResponse({ error: { message: 'not found' } }, 404);
  return jsonResponse(m);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const settings = await loadSettings();
  try {
    const result = await destroyById({ endpoint: settings.endpoint, region: settings.region }, id);
    return jsonResponse({ id, ...result });
  } catch (e) {
    return jsonResponse({ error: { message: (e as Error).message } }, 400);
  }
}
