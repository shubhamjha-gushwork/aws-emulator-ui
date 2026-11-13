'use client';

import { useEffect, useState } from 'react';
import { LuCircleCheck, LuCircleX, LuPlug, LuSettings } from 'react-icons/lu';
import { useStatus } from '@/components/AppShell';
import { PageHeader } from '@/components/PageHeader';
import { useToast } from '@/components/toast';
import { Button, Card, CardHeader, Input, KV, Pill } from '@/components/ui';
import type { Settings } from '@/lib/settings';

export default function SettingsPage() {
  const toast = useToast();
  const { status, reload } = useStatus(null);
  const [endpoint, setEndpoint] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/settings').then(async (r) => {
      const s = (await r.json()) as Settings;
      setEndpoint(s.endpoint);
    });
  }, []);

  if (!endpoint) return null;

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error?.message ?? 'Save failed');
      setEndpoint((body as Settings).endpoint);
      toast('ok', `Using ${(body as Settings).endpoint}`);
      setTimeout(() => window.location.reload(), 400);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-4xl">
      <PageHeader title="Settings" icon={LuSettings} subtitle="The UI talks to Floci on your machine. Change the region from the menu in the top bar." />
      <div className="grid grid-cols-1 gap-6">
        <Card>
          <CardHeader title="Floci" subtitle="Credentials are test/test and are never shown here. Data lives in memory until Floci is stopped." />
          <div className="flex flex-col gap-3 px-5 py-5">
            <label className="text-sm font-medium text-neutral-700">Endpoint</label>
            <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} aria-label="Floci endpoint" className="font-mono text-[13px]" placeholder="http://127.0.0.1:4566" />
            <p className="text-sm text-neutral-500">Default is http://127.0.0.1:4566 (HTTP). Start Floci and the UI with scripts/start-local.sh.</p>
          </div>
          <div className="flex justify-end gap-2 rounded-b-xl border-t border-neutral-100 bg-neutral-25 px-5 py-3">
            <Button onClick={() => reload()}>
              <LuPlug /> Test connection
            </Button>
            <Button variant="primary" loading={saving} onClick={save}>
              Save
            </Button>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Current connection"
            actions={status ? status.health.ok ? <Pill tone="green" dot>Connected</Pill> : <Pill tone="red" dot>Disconnected</Pill> : null}
          />
          <div className="px-5 py-5">
            {status ? (
              <KV
                items={[
                  ['Backend', status.backendLabel ?? 'Floci'],
                  ['Endpoint', <span key="e" className="font-mono text-[13px]">{status.endpoint}</span>],
                  ['Health check', status.health.ok ? <span key="h" className="inline-flex items-center gap-1 text-gw-green-700"><LuCircleCheck className="h-4 w-4" /> 200 in {status.health.ms} ms</span> : <span key="h" className="inline-flex items-center gap-1 text-gw-red-700"><LuCircleX className="h-4 w-4" /> {status.health.error ?? `HTTP ${status.health.status}`}</span>],
                  ['TLS', 'Off (HTTP)'],
                  ['Region', status.region],
                ]}
              />
            ) : (
              <span className="text-sm text-neutral-500">Checking…</span>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
