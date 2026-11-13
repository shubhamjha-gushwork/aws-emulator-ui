import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware, isAllowedOrigin, isLocalHost } from '@/middleware';
import { sanitizeSettings } from '@/lib/settings';

const req = (method: string, headers: Record<string, string>) =>
  new NextRequest('http://127.0.0.1:3297/api/aws/lambda/delete', { method, headers });

describe('api middleware', () => {
  it('accepts only local Host headers', () => {
    expect(isLocalHost('127.0.0.1:3297')).toBe(true);
    expect(isLocalHost('localhost:3297')).toBe(true);
    expect(isLocalHost('[::1]:3297')).toBe(true);
    expect(isLocalHost('evil.example:3297')).toBe(false);
    expect(isLocalHost('127.0.0.1.evil.example')).toBe(false);
    expect(isLocalHost(null)).toBe(false);
  });
  it('requires a same-origin Origin for writes', () => {
    expect(isAllowedOrigin('http://127.0.0.1:3297', '127.0.0.1:3297')).toBe(true);
    expect(isAllowedOrigin('http://localhost:3297', '127.0.0.1:3297')).toBe(false);
    expect(isAllowedOrigin('https://evil.example', '127.0.0.1:3297')).toBe(false);
    expect(isAllowedOrigin('null', '127.0.0.1:3297')).toBe(false);
    expect(isAllowedOrigin(null, '127.0.0.1:3297')).toBe(false);
  });
  it('blocks DNS-rebinding hosts and cross-site POSTs, allows local ones', () => {
    expect(middleware(req('GET', { host: 'rebind.evil.example:3297' })).status).toBe(403);
    expect(middleware(req('POST', { host: '127.0.0.1:3297', origin: 'https://evil.example' })).status).toBe(403);
    expect(middleware(req('DELETE', { host: '127.0.0.1:3297' })).status).toBe(403);
    expect(middleware(req('POST', { host: '127.0.0.1:3297', origin: 'http://127.0.0.1:3297' })).status).toBe(200);
    expect(middleware(req('PUT', { host: '127.0.0.1:3297', referer: 'http://127.0.0.1:3297/settings' })).status).toBe(200);
    expect(middleware(req('GET', { host: 'localhost:3297' })).status).toBe(200);
  });
});

describe('endpoint switcher', () => {
  it('only allows local endpoints', () => {
    expect(sanitizeSettings({ endpoint: 'http://localhost:4566' }).endpoint).toBe('http://localhost:4566');
    expect(sanitizeSettings({ endpoint: 'http://host.docker.internal:4566' }).endpoint).toBe('http://host.docker.internal:4566');
    expect(() => sanitizeSettings({ endpoint: 'http://169.254.169.254' })).toThrow();
    expect(() => sanitizeSettings({ endpoint: 'https://example.com' })).toThrow();
  });
});
