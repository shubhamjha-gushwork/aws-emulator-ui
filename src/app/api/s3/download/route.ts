import { GetObjectCommand } from '@aws-sdk/client-s3';
import { resolveConfig } from '@/lib/aws';
import { normalizeError } from '@/lib/errors';
import { s3Client } from '@/lib/services/s3';
import { makeCtx } from '@/lib/services/types';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const u = new URL(req.url);
  const bucket = u.searchParams.get('bucket');
  const key = u.searchParams.get('key');
  if (!bucket || !key) return new Response('bucket and key are required', { status: 400 });
  try {
    const r = await s3Client(makeCtx(await resolveConfig())).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = await r.Body!.transformToByteArray();
    const filename = key.split('/').pop() || 'download';
    return new Response(Buffer.from(bytes), {
      headers: {
        'content-type': r.ContentType || 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  } catch (e) {
    const err = normalizeError(e);
    return new Response(`${err.name}: ${err.message}`, { status: 502 });
  }
}
