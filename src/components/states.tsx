'use client';

import Link from 'next/link';
import { LuCircleAlert, LuFlaskConical, LuPlug } from 'react-icons/lu';
import type { ApiError } from '@/lib/errors';
import { Pill } from './ui';

/** Renders an API error. NotImplemented answers get the "not supported by Floci yet" treatment. */
export function ErrorState({ error, what, compact }: { error: ApiError; what?: string; compact?: boolean }) {
  if (error.notImplemented) {
    return (
      <div className={compact ? 'px-4 py-3' : 'px-5 py-8'} data-testid="not-supported">
        <div className="mx-auto flex max-w-xl flex-col items-center gap-2 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gw-orange-100">
            <LuFlaskConical className="h-5 w-5 text-gw-orange-700" />
          </div>
          <Pill tone="orange">Not supported by Floci yet</Pill>
          <p className="text-sm text-neutral-600">
            {what ? <>Floci doesn&apos;t implement <span className="font-medium text-neutral-900">{what}</span> yet. </> : null}
            It answered <span className="font-mono text-[12.5px]">{error.name}</span>, so there&apos;s no data to show — nothing here is faked.
          </p>
          <p className="max-w-lg break-words text-xs text-neutral-500">{error.message}</p>
        </div>
      </div>
    );
  }
  if (error.connection) {
    return (
      <div className={compact ? 'px-4 py-3' : 'px-5 py-8'}>
        <div className="mx-auto flex max-w-xl flex-col items-center gap-2 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gw-red-100">
            <LuPlug className="h-5 w-5 text-gw-red-700" />
          </div>
          <Pill tone="red">Can&apos;t reach Floci</Pill>
          <p className="text-sm text-neutral-600">
            Start it with <span className="font-mono text-[12.5px]">scripts/start-local.sh</span>, or check the endpoint in{' '}
            <Link href="/settings" className="text-primary hover:underline">Settings</Link>.
          </p>
          <p className="max-w-lg break-words text-xs text-neutral-500">{error.message}</p>
        </div>
      </div>
    );
  }
  return (
    <div className={compact ? 'px-4 py-3' : 'px-5 py-6'}>
      <div className="flex items-start gap-2 rounded-lg border border-gw-red-100 bg-gw-red-100/40 px-4 py-3 text-sm text-gw-red-700">
        <LuCircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <span className="font-semibold">{error.name}</span>
          <span className="break-words">: {error.message}</span>
        </div>
      </div>
    </div>
  );
}

export function InlineError({ error }: { error?: ApiError | null }) {
  if (!error) return null;
  if (error.notImplemented)
    return (
      <div className="rounded-lg border border-gw-orange-100 bg-gw-orange-100/40 px-3 py-2 text-sm text-gw-orange-700">
        <span className="font-semibold">Not supported by Floci yet.</span> <span className="break-words text-xs">{error.message}</span>
      </div>
    );
  return (
    <div role="alert" className="rounded-lg border border-gw-red-100 bg-gw-red-100/40 px-3 py-2 text-sm text-gw-red-700">
      <span className="font-semibold">{error.name}</span>: <span className="break-words">{error.message}</span>
    </div>
  );
}
