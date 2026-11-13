'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiError } from '@/lib/errors';

export class AwsCallError extends Error {
  constructor(public error: ApiError) {
    super(error.message);
    this.name = error.name;
  }
}

export async function callAws<T = unknown>(service: string, action: string, params: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/aws/${service}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
  } catch (e) {
    throw new AwsCallError({ name: 'NetworkError', message: (e as Error).message, notImplemented: false, connection: true });
  }
  const body = (await res.json().catch(() => ({}))) as { data?: T; error?: ApiError };
  if (body.error) throw new AwsCallError(body.error);
  if (!res.ok) throw new AwsCallError({ name: 'HttpError', message: `HTTP ${res.status}`, status: res.status, notImplemented: false, connection: false });
  return body.data as T;
}

export function toApiError(e: unknown): ApiError {
  if (e instanceof AwsCallError) return e.error;
  return { name: 'Error', message: (e as Error)?.message ?? String(e), notImplemented: false, connection: false };
}

/** Fetch an action's result; re-runs when `key` changes. Pass `params === null` to skip. */
export function useAws<T = unknown>(service: string, action: string, params: Record<string, unknown> | null = {}) {
  const key = params === null ? null : JSON.stringify(params);
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [loading, setLoading] = useState(key !== null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (key === null) return;
    const id = ++seq.current;
    setLoading(true);
    try {
      const d = await callAws<T>(service, action, JSON.parse(key));
      if (id === seq.current) {
        setData(d);
        setError(undefined);
      }
    } catch (e) {
      if (id === seq.current) setError(toApiError(e));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [service, action, key]);

  useEffect(() => {
    setData(undefined);
    setError(undefined);
    void load();
  }, [load]);

  return { data, error, loading, reload: load };
}
