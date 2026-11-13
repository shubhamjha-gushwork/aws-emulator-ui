import type { ReactNode } from 'react';
import { serviceById } from '@/lib/catalog';
import { SERVICE_ICONS } from './icons';

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
          <h1 className="font-grotesk text-[28px] font-semibold leading-tight text-neutral-900">{title ?? svc?.name}</h1>
          <p className="font-grotesk text-base font-medium text-neutral-500">{subtitle ?? svc?.description}</p>
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
