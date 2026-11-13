'use client';

import { useEffect, useRef, useState } from 'react';
import { LuCheck, LuChevronDown, LuGlobe } from 'react-icons/lu';
import { REGIONS, regionName } from '@/lib/regions';
import { cn } from '@/lib/cn';

/** Saves the region to settings; the caller decides how to refresh. */
export async function saveRegion(region: string) {
  const r = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ region }) });
  if (!r.ok) throw new Error(((await r.json()) as { error?: { message?: string } })?.error?.message ?? 'Could not save region');
}

/**
 * AWS-console-style region menu. `onChange` defaults to saving the region and reloading the page,
 * so every list and count is fetched again for the new region.
 */
export function RegionPicker({ value, onChange, align = 'right' }: { value?: string; onChange?: (code: string) => void | Promise<void>; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const pick = async (code: string) => {
    setOpen(false);
    if (code === value) return;
    setBusy(true);
    try {
      if (onChange) await onChange(code);
      else {
        await saveRegion(code);
        window.location.reload();
      }
    } finally {
      setBusy(false);
    }
  };

  const groups = [...new Set(REGIONS.map((r) => r.group))];
  const extra = value && !REGIONS.some((r) => r.code === value) ? value : null;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-testid="region-picker"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen(!open)}
        className={cn(
          'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-neutral-100 bg-white px-2.5 text-sm font-medium text-neutral-800 transition-colors hover:border-neutral-200 disabled:opacity-60',
        )}
      >
        <LuGlobe className="h-4 w-4 text-neutral-500" />
        <span className="hidden lg:inline">{regionName(value)}</span>
        <span className="font-mono text-xs text-neutral-500">{value}</span>
        <LuChevronDown className={cn('ml-auto h-4 w-4 text-neutral-400 transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label="Region"
          className={cn('absolute z-50 mt-2 w-80 overflow-hidden rounded-xl border border-neutral-100 bg-white py-1.5 shadow-s4', align === 'right' ? 'right-0' : 'left-0')}
        >
          {groups.map((g) => (
            <div key={g} className="py-1">
              <div className="px-4 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{g}</div>
              {REGIONS.filter((r) => r.group === g).map((r) => (
                <button
                  key={r.code}
                  type="button"
                  role="option"
                  aria-selected={r.code === value}
                  onClick={() => void pick(r.code)}
                  className={cn('flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left text-sm hover:bg-neutral-25', r.code === value ? 'text-primary-500' : 'text-neutral-800')}
                >
                  <span className="flex-1">{r.name}</span>
                  <span className={cn('font-mono text-xs', r.code === value ? 'text-primary-500' : 'text-neutral-500')}>{r.code}</span>
                  <LuCheck className={cn('h-4 w-4', r.code === value ? 'text-primary-500' : 'invisible')} />
                </button>
              ))}
            </div>
          ))}
          {extra ? <div className="border-t border-neutral-100 px-4 py-2 text-xs text-neutral-500">Current: <span className="font-mono">{extra}</span> (set via AWS_EMULATOR_REGION)</div> : null}
        </div>
      ) : null}
    </div>
  );
}
