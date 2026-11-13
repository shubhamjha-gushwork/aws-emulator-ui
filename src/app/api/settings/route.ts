import { loadSettings, saveSettings, type Settings } from '@/lib/settings';
import { jsonResponse } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

const redact = (s: Settings) => ({ ...s, secretAccessKey: s.secretAccessKey ? '••••••••' : '' });

export async function GET() {
  return jsonResponse(redact(await loadSettings()));
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as Partial<Settings>;
    if (body.secretAccessKey === '••••••••') delete body.secretAccessKey;
    return jsonResponse(redact(await saveSettings(body)));
  } catch (e) {
    return jsonResponse({ error: { name: 'InputError', message: (e as Error).message } }, 400);
  }
}
