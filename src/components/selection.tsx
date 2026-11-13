'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * List → full-page detail navigation kept in the URL (?param=value), so Back/Forward and reloads work
 * like the AWS console. Uses the History API directly to avoid a Suspense boundary per page.
 */
const EVENT = 'emulator:selection';

export function useSelection(param: string): [string | null, (v: string | null) => void] {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setValue(new URLSearchParams(window.location.search).get(param));
    read();
    window.addEventListener('popstate', read);
    window.addEventListener(EVENT, read);
    return () => {
      window.removeEventListener('popstate', read);
      window.removeEventListener(EVENT, read);
    };
  }, [param]);
  const set = useCallback(
    (v: string | null) => {
      const url = new URL(window.location.href);
      if (v === null) url.searchParams.delete(param);
      else url.searchParams.set(param, v);
      window.history.pushState(null, '', url);
      setValue(v);
      window.dispatchEvent(new Event(EVENT)); // keep other readers of the same param (e.g. the page header) in sync
      document.querySelector('main')?.scrollTo({ top: 0 });
    },
    [param],
  );
  return [value, set];
}
