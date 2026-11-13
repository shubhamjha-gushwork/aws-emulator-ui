'use client';

import { useEffect, useState } from 'react';
import { LuCircleCheck, LuCircleX, LuPlug } from 'react-icons/lu';
import { useStatus } from '@/components/AppShell';
import { PageHeader } from '@/components/PageHeader';
import { useToast } from '@/components/toast';
import { Button, Card, CardHeader, Checkbox, Field, Input, KV, Pill, Segmented } from '@/components/ui';

interface SettingsForm {
  endpoint: string;
  region: string;
  credentialsMode: 'auto' | 'manual';
  accessKeyId: string;
  secretAccessKey: string;
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
      const r = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) });
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error?.message ?? 'Save failed');
      setForm(body as SettingsForm);
      toast('ok', 'Settings saved');
      await reload();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-4xl">
      <PageHeader title="Settings" subtitle="Where the UI sends AWS API calls. Saved locally in .data/settings.json." />
      <div className="grid grid-cols-1 gap-6">
        <Card>
          <CardHeader title="Emulator connection" subtitle="AWS Emulator serves HTTPS on 127.0.0.1:9297 by default" />
          <div className="flex flex-col gap-5 px-5 py-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_200px]">
              <Field label="Endpoint URL" hint="Use the endpoint_url from the emulator's startup log line (e.g. -p 9300 → https://127.0.0.1:9300)">
                <Input value={form.endpoint} onChange={(e) => set('endpoint', e.target.value)} placeholder="https://127.0.0.1:9297" />
              </Field>
              <Field label="Region" hint="Use one region per emulator">
                <Input value={form.region} onChange={(e) => set('region', e.target.value)} placeholder="us-east-1" />
              </Field>
            </div>
            <Field label="Credentials">
              <div>
                <Segmented
                  value={form.credentialsMode}
                  onChange={(v) => set('credentialsMode', v)}
                  options={[
                    { value: 'auto', label: 'Auto (emulator run keys)' },
                    { value: 'manual', label: 'Manual' },
                  ]}
                />
              </div>
            </Field>
            {form.credentialsMode === 'auto' ? (
              <p className="-mt-2 text-sm text-neutral-600">
                Each run, the emulator writes fresh SigV4 keys and a CA certificate to <span className="font-mono text-[12.5px]">~/.aws/emulator/&lt;port&gt;/</span>. The UI
                reads them on every request, so restarts just work. If they&apos;re missing (e.g. <span className="font-mono text-[12.5px]">--auth off</span>), dummy keys are used.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Access key ID">
                  <Input value={form.accessKeyId} onChange={(e) => set('accessKeyId', e.target.value)} />
                </Field>
                <Field label="Secret access key">
                  <Input type="password" value={form.secretAccessKey} onChange={(e) => set('secretAccessKey', e.target.value)} />
                </Field>
              </div>
            )}
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
                  ['Region', status.region],
                  ['Health check', status.health.ok ? <span key="h" className="inline-flex items-center gap-1 text-gw-green-700"><LuCircleCheck className="h-4 w-4" /> 200 in {status.health.ms} ms</span> : <span key="h" className="inline-flex items-center gap-1 text-gw-red-700"><LuCircleX className="h-4 w-4" /> {status.health.error ?? `HTTP ${status.health.status}`}</span>],
                  ['Credential source', status.credentialSource],
                  ['CA certificate', status.caLoaded ? 'Loaded from run folder' : 'Not found'],
                  ['Run folder', <span key="r" className="font-mono text-[13px]">{status.runDir}</span>],
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
