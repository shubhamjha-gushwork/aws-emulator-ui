import { loadSettings, saveSettings, type Settings } from '@/lib/settings';
import { jsonResponse } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

export async function GET() {
  return jsonResponse(await loadSettings());
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as Partial<Settings>;
    return jsonResponse(await saveSettings(body));
  } catch (e) {
    return jsonResponse({ error: { name: 'InputError', message: (e as Error).message } }, 400);
  }
}
