import { listManifests } from '@/lib/deploy/state';
import { jsonResponse } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

export async function GET() {
  return jsonResponse({ deployments: listManifests() });
}
