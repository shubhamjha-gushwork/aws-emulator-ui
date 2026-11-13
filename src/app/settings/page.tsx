'use client';

import { useEffect, useState } from 'react';
import { LuCircleCheck, LuCircleX, LuPlug, LuSettings } from 'react-icons/lu';
import { useStatus } from '@/components/AppShell';
import { PageHeader } from '@/components/PageHeader';
import { useToast } from '@/components/toast';
import { Button, Card, CardHeader, Checkbox, Field, Input, KV, Pill } from '@/components/ui';

interface SettingsForm {
  endpoint: string;
  tlsVerify: boolean;
}

export default function SettingsPage() {
  const toast = useToast();
  const { status, reload } = useStatus(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/settings').then(async (r) => setForm((await r.json()) as SettingsForm));
  }, []);

  if (!form) return null;
  const set = <K extends keyof SettingsForm>(k: K, v: SettingsForm[K]) => setForm({ ...form, [k]: v });

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: form.endpoint, tlsVerify: form.tlsVerify }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error?.message ?? 'Save failed');
      setForm(body as SettingsForm);
      toast('ok', 'Settings saved');
      // Reload so the nav bar and every page pick up the new endpoint.
      setTimeout(() => window.location.reload(), 400);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-4xl">
      <PageHeader title="Settings" icon={LuSettings} subtitle="Where the UI sends AWS API calls. Change the region from the menu in the top bar." />
      <div className="grid grid-cols-1 gap-6">
        <Card>
          <CardHeader title="Emulator connection" subtitle="AWS Emulator serves HTTPS on 127.0.0.1:9297 by default" />
          <div className="flex flex-col gap-5 px-5 py-5">
            <Field label="Endpoint URL" hint="Use the endpoint_url from the emulator's startup log line (e.g. -p 9300 → https://127.0.0.1:9300)">
                <Input value={form.endpoint} onChange={(e) => set('endpoint', e.target.value)} placeholder="https://127.0.0.1:9297" />
            </Field>
            <Checkbox label="Verify TLS with the emulator's ca.pem (recommended)" checked={form.tlsVerify} onChange={(v) => set('tlsVerify', v)} />
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
                  ['Endpoint', <span key="e" className="font-mono text-[13px]">{status.endpoint}</span>],
                  ['Health check', status.health.ok ? <span key="h" className="inline-flex items-center gap-1 text-gw-green-700"><LuCircleCheck className="h-4 w-4" /> 200 in {status.health.ms} ms</span> : <span key="h" className="inline-flex items-center gap-1 text-gw-red-700"><LuCircleX className="h-4 w-4" /> {status.health.error ?? `HTTP ${status.health.status}`}</span>],
                  ['TLS', status.tlsVerify ? (status.caLoaded ? 'Verified with the emulator\'s certificate' : 'Certificate not found') : 'Verification off'],
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
