import { NextResponse, type NextRequest } from 'next/server';

/**
 * The UI is a local console: it must only be reachable as localhost.
 * - Host allowlist on every /api request blocks DNS-rebinding (evil.example → 127.0.0.1).
 * - For non-GET/HEAD requests the Origin (or Referer) must be the same local origin,
 *   so a web page in another tab cannot POST/PUT/DELETE to the API (CSRF).
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostname(hostHeader: string | null): string | undefined {
  if (!hostHeader) return undefined;
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

export function isLocalHost(hostHeader: string | null): boolean {
  const h = hostname(hostHeader);
  return !!h && (LOCAL_HOSTS.has(h) || h.endsWith('.localhost'));
}

export function isAllowedOrigin(origin: string | null, hostHeader: string | null): boolean {
  if (!origin || origin === 'null') return false;
  try {
    const u = new URL(origin);
    return isLocalHost(u.host) && u.host.toLowerCase() === (hostHeader ?? '').toLowerCase();
  } catch {
    return false;
  }
}

export function middleware(req: NextRequest) {
  const host = req.headers.get('host');
  if (!isLocalHost(host)) {
    return NextResponse.json({ error: { name: 'Forbidden', message: 'Host not allowed' } }, { status: 403 });
  }
  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const origin = req.headers.get('origin') ?? (() => {
      const ref = req.headers.get('referer');
      try { return ref ? new URL(ref).origin : null; } catch { return null; }
    })();
    if (!isAllowedOrigin(origin, host)) {
      return NextResponse.json({ error: { name: 'Forbidden', message: 'Cross-origin request blocked' } }, { status: 403 });
    }
  }
  return NextResponse.next();
}

export const config = { matcher: ['/api/:path*'] };
