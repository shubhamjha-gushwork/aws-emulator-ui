import type { ReactNode } from 'react';
import { FIDELITY, serviceById } from '@/lib/catalog';
import { SERVICE_ICONS } from './icons';
import { Pill } from './ui';

export function fidelityTone(pct: number | null | undefined) {
  if (pct === null || pct === undefined) return 'gray' as const;
  if (pct >= 85) return 'green' as const;
  if (pct >= 70) return 'blue' as const;
  if (pct >= 60) return 'yellow' as const;
  return 'orange' as const;
}

export function FidelityPills({ serviceId }: { serviceId: string }) {
  const svc = serviceById(serviceId);
  if (!svc) return null;
  return (
    <>
      {svc.fidelityKeys.map((f) => {
        const s = FIDELITY.scores[f.key];
        return (
          <Pill key={f.key} tone={fidelityTone(s?.pct)} className="font-normal">
            {svc.fidelityKeys.length > 1 ? `${f.label} ` : ''}fidelity {s?.pct ?? '—'}%
          </Pill>
        );
      })}
    </>
  );
}

export function PageHeader({ serviceId, title, subtitle, actions }: { serviceId?: string; title?: string; subtitle?: string; actions?: ReactNode }) {
  const svc = serviceId ? serviceById(serviceId) : undefined;
  const Icon = serviceId ? SERVICE_ICONS[serviceId] : undefined;
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        {Icon ? (
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary">
            <Icon className="h-6 w-6 text-white" />
          </div>
        ) : null}
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-grotesk text-[28px] font-semibold leading-tight text-neutral-900">{title ?? svc?.name}</h1>
            {serviceId ? <FidelityPills serviceId={serviceId} /> : null}
          </div>
          <p className="font-grotesk text-base font-medium text-neutral-500">{subtitle ?? svc?.description}</p>
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
