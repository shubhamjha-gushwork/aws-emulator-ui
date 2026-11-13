'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { LuActivity, LuArrowUpRight, LuGauge, LuGlobe, LuRefreshCw, LuServer } from 'react-icons/lu';
import { useStatus } from '@/components/AppShell';
import { SERVICE_ICONS } from '@/components/icons';
import { Button, Card, Pill, TimeAgo } from '@/components/ui';
import { SERVICES } from '@/lib/catalog';
import { regionName } from '@/lib/regions';
import { cn } from '@/lib/cn';

type Overview = Record<string, { counts: { label: string; value: number }[]; ms: number }>;

export default function OverviewPage() {
  const { status, reload: reloadStatus } = useStatus(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/overview', { cache: 'no-store' });
      setOverview((await r.json()) as Overview);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const ok = status?.health.ok;
  const total = overview ? Object.values(overview).flatMap((o) => o.counts).reduce((a, c) => a + Math.max(0, c.value), 0) : null;

  const metrics = [
    { icon: LuActivity, label: 'Emulator', value: status === null ? '…' : ok ? 'Healthy' : 'Offline', pill: status === null ? null : ok ? <Pill tone="green" dot>/__admin/health 200</Pill> : <Pill tone="red" dot>{status.health.error ?? `HTTP ${status.health.status}`}</Pill> },
    { icon: LuGauge, label: 'Health latency', value: status ? `${status.health.ms} ms` : '…', pill: null },
    { icon: LuServer, label: 'Resources', value: total === null ? '…' : total.toLocaleString(), pill: <Pill tone="blue">13 services</Pill> },
    { icon: LuGlobe, label: 'Region', value: status ? regionName(status.region) : '…', pill: status ? <Pill tone="blue">{status.region}</Pill> : null, small: true },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-grotesk text-2xl font-medium leading-tight text-neutral-900">Overview</h1>
          <p className="mt-0.5 text-sm text-neutral-500">
            {status ? (
              <>
                <span className="font-mono text-[13px]">{status.endpoint}</span> · {status.region} · checked <TimeAgo value={status.checkedAt} />
              </>
            ) : (
              'Connecting to AWS Emulator…'
            )}
          </p>
        </div>
        <Button
          onClick={() => {
            void reloadStatus();
            void load();
          }}
          loading={loading}
        >
          {!loading && <LuRefreshCw />} Refresh
        </Button>
      </div>

      <div className="flex flex-col divide-y divide-neutral-100 overflow-hidden rounded-xl border border-neutral-100 bg-white shadow-s3 sm:flex-row sm:divide-x sm:divide-y-0">
        {metrics.map((m) => (
          <div key={m.label} className="flex w-full flex-1 flex-col gap-1.5 px-7 py-6">
            <div className="flex items-center gap-1.5">
              <m.icon className="h-5 w-5 text-primary-500" />
              <h3 className="text-base font-normal text-neutral-900">{m.label}</h3>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className={cn('font-grotesk font-semibold leading-[140%] text-neutral-900', m.small ? 'text-[22px]' : 'text-[32px]')}>{m.value}</div>
              {m.pill}
            </div>
          </div>
        ))}
      </div>

      {status && !ok ? (
        <Card className="px-6 py-5">
          <div className="font-grotesk text-lg font-medium text-neutral-900">The emulator isn&apos;t answering</div>
          <p className="mt-1 text-sm text-neutral-600">
            Start it with <code className="rounded bg-neutral-50 px-1.5 py-0.5 font-mono text-[12.5px]">scripts/start-local.sh</code> (or{' '}
            <code className="rounded bg-neutral-50 px-1.5 py-0.5 font-mono text-[12.5px]">aws-emulator</code> on Linux), then refresh.
          </p>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {SERVICES.map((s) => {
          const Icon = SERVICE_ICONS[s.id];
          const o = overview?.[s.id];
          return (
            <Link key={s.id} href={s.href} className="group" data-testid={`svc-card-${s.id}`}>
              <Card className="flex h-full flex-col transition-shadow group-hover:shadow-s4">
                <div className="flex items-start justify-between gap-3 px-5 pt-4">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary-25">
                      <Icon className="h-5 w-5 text-primary-500" />
                    </div>
                    <div>
                      <div className="flex items-center gap-1 font-grotesk text-base font-semibold text-neutral-900">
                        {s.name}
                        <LuArrowUpRight className="h-3.5 w-3.5 text-neutral-400 opacity-0 transition-opacity group-hover:opacity-100" />
                      </div>
                      <div className="text-[13px] text-neutral-500">{s.description}</div>
                    </div>
                  </div>
                </div>
                <div className="mt-auto flex items-end justify-between gap-3 px-5 pb-4 pt-4">
                  <div className="flex gap-6">
                    {(o?.counts ?? [{ label: '…', value: NaN }]).map((c, i) => (
                      <div key={`${c.label}-${i}`}>
                        <div className="font-grotesk text-[26px] font-semibold leading-none text-neutral-900">
                          {Number.isNaN(c.value) ? '…' : c.value < 0 ? '—' : c.value}
                        </div>
                        <div className="mt-1 text-xs text-neutral-500">{c.value < 0 ? `${c.label} (error)` : c.label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </Card>
            </Link>
          );
        })}
      </div>

    </div>
  );
}
