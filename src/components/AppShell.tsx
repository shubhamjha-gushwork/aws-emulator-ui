'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { LuLayoutDashboard, LuRocket, LuSettings } from 'react-icons/lu';
import { SERVICES } from '@/lib/catalog';
import { cn } from '@/lib/cn';
import { SERVICE_ICONS } from './icons';
import { ToastProvider } from './toast';
import { Pill, useInterval } from './ui';
import { RegionPicker } from './RegionPicker';

export interface Status {
  backend?: 'floci';
  backendLabel?: string;
  endpoint: string;
  region: string;
  caLoaded: boolean;
  tlsVerify: boolean;
  health: { ok: boolean; status?: number; ms: number; error?: string };
  checkedAt: string;
}

export function useStatus(pollMs: number | null = 10000) {
  const [status, setStatus] = useState<Status | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      setStatus((await r.json()) as Status);
    } catch {
      setStatus(null);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useInterval(load, pollMs);
  return { status, reload: load };
}

function NavLink({ href, icon: Icon, children, active }: { href: string; icon: React.ComponentType<{ className?: string }>; children: ReactNode; active: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
        active ? 'bg-primary-25 font-medium text-primary-500' : 'text-neutral-600 hover:bg-neutral-25 hover:text-neutral-900',
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-primary-500' : 'text-neutral-500')} />
      <span className="truncate">{children}</span>
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { status } = useStatus();
  const connected = status?.health.ok;
  return (
    <ToastProvider>
      <div className="flex h-screen flex-col overflow-hidden">
        <nav className="z-20 flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3">
          <Link href="/" className="flex items-center gap-3">
            <img src="https://cdn.gushwork.ai/v2/gush_new_logo.svg" alt="Gushwork" className="h-[30px] w-[30px]" />
            <div className="flex items-baseline gap-2">
              <span className="font-grotesk text-lg font-semibold text-neutral-900">AWS Emulator</span>
              <span className="hidden text-[13px] text-neutral-500 sm:inline">local console</span>
            </div>
          </Link>
          <div className="flex items-center gap-3">
            {status ? (
              <span className="hidden items-center gap-2 text-xs text-neutral-500 sm:flex">
                <span className="font-medium text-neutral-700">{status.backendLabel ?? "Floci"}</span>
                <span className="hidden font-mono xl:inline">{status.endpoint}</span>
              </span>
            ) : null}
            {status ? <RegionPicker value={status.region} /> : null}
            <Link href="/settings" data-testid="connection-pill">
              {status === null ? (
                <Pill tone="gray" dot>Checking…</Pill>
              ) : connected ? (
                <Pill tone="green" dot>Connected</Pill>
              ) : (
                <Pill tone="red" dot>Disconnected</Pill>
              )}
            </Link>
            <Link href="/settings" aria-label="Settings" className="flex size-8 items-center justify-center rounded-full border border-neutral-100 bg-neutral-25 text-neutral-600 hover:text-neutral-900">
              <LuSettings className="h-4 w-4" />
            </Link>
          </div>
        </nav>
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-60 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-neutral-100 bg-white p-3 lg:flex">
            <NavLink href="/" icon={LuLayoutDashboard} active={pathname === '/'}>Overview</NavLink>
            <div className="mb-1 mt-4 px-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">Services</div>
            {SERVICES.map((s) => (
              <NavLink key={s.id} href={s.href} icon={SERVICE_ICONS[s.id]} active={pathname.startsWith(s.href)}>
                {s.short}
              </NavLink>
            ))}
            <div className="mt-auto flex flex-col gap-0.5 pt-4">
              <NavLink href="/deployments" icon={LuRocket} active={pathname.startsWith('/deployments')}>Deployments</NavLink>
              <NavLink href="/settings" icon={LuSettings} active={pathname === '/settings'}>Settings</NavLink>
            </div>
          </aside>
          <main className="min-w-0 flex-1 overflow-y-auto bg-[url('https://cdn.gushwork.ai/v2/gush-bg.webp')] bg-cover bg-fixed bg-center">
            <div className="mx-auto max-w-[1400px] p-6 lg:p-8">{children}</div>
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
