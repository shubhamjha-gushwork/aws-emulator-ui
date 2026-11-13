import Link from 'next/link';
import type { ReactNode } from 'react';
import type { IconType } from 'react-icons';
import { LuChevronRight } from 'react-icons/lu';
import { serviceById } from '@/lib/catalog';
import { SERVICE_ICONS } from './icons';

/**
 * Page header: small breadcrumb, a soft icon tile, the title in VertGrotesk, one plain line of description,
 * and the page's actions on the right. On a detail view, pass `detail` and the breadcrumb ends with the resource.
 */
export function PageHeader({ serviceId, title, subtitle, actions, detail, icon }: {
  serviceId?: string; title?: string; subtitle?: string; actions?: ReactNode; icon?: IconType;
  detail?: { name: string; onBack?: () => void; href?: string };
}) {
  const svc = serviceId ? serviceById(serviceId) : undefined;
  const Icon = icon ?? (serviceId ? SERVICE_ICONS[serviceId] : undefined);
  const name = title ?? svc?.name ?? '';
  const crumbCls = 'transition-colors hover:text-neutral-900';
  return (
    <header className="mb-6 flex flex-col gap-3">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-[13px] text-neutral-500">
        <Link href="/" className={crumbCls}>{svc ? 'Services' : 'AWS Emulator'}</Link>
        <LuChevronRight className="size-3.5 shrink-0 text-neutral-400" />
        {detail ? (
          <>
            {detail.href ? (
              <Link href={detail.href} className={crumbCls} data-testid="crumb-back">{svc?.short ?? name}</Link>
            ) : (
              <button type="button" onClick={detail.onBack} className={`cursor-pointer ${crumbCls}`} data-testid="crumb-back">{svc?.short ?? name}</button>
            )}
            <LuChevronRight className="size-3.5 shrink-0 text-neutral-400" />
            <span className="truncate font-medium text-neutral-800">{detail.name}</span>
          </>
        ) : (
          <span className="font-medium text-neutral-800">{svc?.short ?? name}</span>
        )}
      </nav>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {Icon ? (
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary-100 bg-primary-25">
              <Icon className="size-5 text-primary-500" />
            </div>
          ) : null}
          <div className="min-w-0">
            <h1 className="truncate font-grotesk text-2xl font-medium leading-tight text-neutral-900">{name}</h1>
            {subtitle ?? svc?.tagline ? <p className="mt-0.5 text-sm text-neutral-500">{subtitle ?? svc?.tagline}</p> : null}
          </div>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
