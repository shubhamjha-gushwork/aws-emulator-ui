'use client';

import { useCallback, useState } from 'react';
import { callAws, toApiError } from './use-aws';
import { useToast } from './toast';
import type { ApiError } from '@/lib/errors';

/** Runs a write action, toasts the outcome, and reports busy/error state. */
export function useMutation() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = useCallback(
    async <T = unknown>(service: string, action: string, params: Record<string, unknown>, success?: string): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      try {
        const r = await callAws<T>(service, action, params);
        if (success) toast('ok', success);
        return r;
      } catch (e) {
        const err = toApiError(e);
        setError(err);
        toast('error', err.notImplemented ? `Not supported by AWS Emulator yet: ${err.message}` : `${err.name}: ${err.message}`);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { run, busy, error, clearError: () => setError(null) };
}
