'use client';

import type { ReactNode } from 'react';
import { LuRefreshCw } from 'react-icons/lu';
import type { ApiError } from '@/lib/errors';
import { cn } from '@/lib/cn';
import { ErrorState } from './states';
import { Button, Card, Spinner } from './ui';

export function ListCard({ title, subtitle, actions, loading, error, onReload, children, className, what, hasData }: {
  title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; loading?: boolean; error?: ApiError; onReload?: () => void; children?: ReactNode;
  className?: string; what?: string; hasData?: boolean;
}) {
  return (
    <Card className={cn('overflow-hidden', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 px-5 py-3">
        <div className="min-w-0">
          <div className="truncate font-grotesk text-lg font-medium text-neutral-900">{title}</div>
          {subtitle ? <div className="truncate text-[13px] text-neutral-500">{subtitle}</div> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          {onReload ? (
            <Button size="icon" variant="ghost" aria-label="Refresh" onClick={onReload} disabled={loading}>
              <LuRefreshCw className={cn(loading && 'animate-spin')} />
            </Button>
          ) : null}
        </div>
      </div>
      {error ? <ErrorState error={error} what={what} /> : loading && !hasData ? <Spinner /> : children}
    </Card>
  );
}

export function Section({ title, children, actions }: { title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600">{title}</h3>
        {actions}
      </div>
      {children}
    </div>
  );
}
