'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { LuRocket, LuTrash2 } from 'react-icons/lu';
import { ListCard } from '@/components/ListCard';
import { PageHeader } from '@/components/PageHeader';
import { useToast } from '@/components/toast';
import { Button, ConfirmDialog, Empty, Mono, Pill } from '@/components/ui';
import type { DeployManifest, ManifestResource } from '@/lib/deploy/types';

export default function DeploymentsPage() {
  const toast = useToast();
  const [items, setItems] = useState<DeployManifest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<DeployManifest | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/deployments', { cache: 'no-store' });
      const body = (await r.json()) as { deployments?: DeployManifest[]; error?: { message: string } };
      if (!r.ok) throw new Error(body.error?.message ?? 'Failed to load deployments');
      setItems(body.deployments ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const destroy = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/deployments/${encodeURIComponent(pending.id)}`, { method: 'DELETE' });
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error?.message ?? 'Destroy failed');
      toast('ok', `Destroyed ${pending.id}`);
      setPending(null);
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Deployments"
        icon={LuRocket}
        subtitle="Resources created by aws-emulator deploy against Floci, grouped by source and stage."
      />
      <ListCard
        title="Recorded deploys"
        subtitle={items ? `${items.length} deployment${items.length === 1 ? '' : 's'}` : undefined}
        actions={<Button size="sm" variant="outline" onClick={() => void load()}>Refresh</Button>}
      >
        {error ? <div className="px-5 py-4 text-sm text-gw-red-700">{error}</div> : null}
        {!items ? <div className="px-5 py-8 text-sm text-neutral-500">Loading…</div> : null}
        {items && !items.length ? (
          <Empty>
            Nothing recorded yet. From the repo run{' '}
            <Mono>npx aws-emulator deploy ./path/to/service --stage local</Mono>
            {' '}or <Mono>npm run deploy:local -- ./path/to/service</Mono>.
          </Empty>
        ) : null}
        <div className="flex flex-col gap-4 p-5 pt-0">
          {items?.map((m) => (
            <article key={m.id} className="rounded-xl border border-neutral-100 bg-white px-5 py-4 shadow-s3" data-testid="deployment">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold text-neutral-900">{m.service}</h2>
                    <Pill tone="blue">{m.kind}</Pill>
                    <Pill>{m.stage}</Pill>
                  </div>
                  <div className="mt-1 text-xs text-neutral-500">
                    <Mono className="text-neutral-600">{m.id}</Mono>
                    <span> · {m.region}</span>
                    <span> · updated {new Date(m.updatedAt).toLocaleString()}</span>
                  </div>
                  <div className="mt-1 truncate text-xs text-neutral-500" title={m.source}>{m.source}</div>
                </div>
                <Button size="sm" variant="danger" onClick={() => setPending(m)}><LuTrash2 /> Destroy</Button>
              </div>
              <ul className="mt-3 divide-y divide-neutral-100 rounded-lg border border-neutral-100">
                {m.resources.map((r, i) => (
                  <ResourceRow key={`${r.kind}:${r.name}:${i}`} r={r} />
                ))}
              </ul>
              {m.placeholders.length ? (
                <p className="mt-3 text-xs text-neutral-500">
                  Placeholder secrets to fill in:{' '}
                  {m.placeholders.map((p) => `${p.name}${p.keys.length ? ` (${p.keys.join(', ')})` : ''}`).join('; ')}
                </p>
              ) : null}
              {m.warnings.length ? (
                <p className="mt-2 text-xs text-neutral-500">{m.warnings.slice(0, 3).join(' · ')}{m.warnings.length > 3 ? ` · +${m.warnings.length - 3} more` : ''}</p>
              ) : null}
            </article>
          ))}
        </div>
      </ListCard>
      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        title={`Destroy ${pending?.id}?`}
        description="Removes the Floci resources recorded for this deploy. Placeholder secrets created for it are deleted too."
        confirmLabel="Destroy"
        busy={busy}
        onConfirm={destroy}
      />
    </>
  );
}

function hrefFor(r: ManifestResource): string | undefined {
  const enc = (v: string) => encodeURIComponent(v);
  const name = r.name;
  const arn = r.arn;
  const id = r.id;
  switch (r.kind) {
    case 'lambda': return name ? `/lambda?fn=${enc(name)}` : '/lambda';
    case 'sqs': return `/sqs?queue=${enc(r.url || name)}`;
    case 's3': return name ? `/s3?bucket=${enc(name)}` : '/s3';
    case 'secret': return `/secrets?secret=${enc(arn || name)}`;
    case 'event-rule': return name ? `/eventbridge?rule=${enc(name)}` : '/eventbridge';
    case 'scheduler': return name ? `/eventbridge?schedule=${enc(name)}` : '/eventbridge';
    case 'apigateway': return id ? `/apigateway?rest=${enc(id)}` : '/apigateway';
    case 'apigatewayv2': return id ? `/apigateway?http=${enc(id)}` : '/apigateway';
    case 'ecs-cluster':
    case 'ecs-service':
      return `/ecs?cluster=${enc(arn || r.extra?.cluster || name)}`;
    case 'ecs-task-definition':
      return `/ecs?taskdef=${enc(arn || name)}`;
    case 'ecr': return name ? `/ecr?repo=${enc(name)}` : '/ecr';
    case 'alb': return `/elb?lb=${enc(arn || name)}`;
    case 'target-group': return `/elb?tg=${enc(arn || name)}`;
    case 'listener': return `/elb?lb=${enc(arn || name)}`;
    case 'log-group': return name ? `/logs/${enc(name)}` : '/logs';
    default: return r.href;
  }
}

function ResourceRow({ r }: { r: ManifestResource }) {
  const href = hrefFor(r) ?? r.href;
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
      <span className="min-w-0 truncate text-neutral-800">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">{r.kind}</span>
        {'  '}
        <Mono className="text-neutral-800">{r.name}</Mono>
      </span>
      {href ? <Link href={href} className="shrink-0 text-xs font-medium text-primary-500 hover:underline">Open</Link> : null}
    </li>
  );
}
