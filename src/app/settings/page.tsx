'use client';

import { useEffect, useState } from 'react';
import { LuCircleCheck, LuCircleX, LuPlug, LuSettings } from 'react-icons/lu';
import { useStatus } from '@/components/AppShell';
import { PageHeader } from '@/components/PageHeader';
import { useToast } from '@/components/toast';
import { Button, Card, CardHeader, KV, Pill } from '@/components/ui';
import { cn } from '@/lib/cn';
import { backendPresets, type BackendId } from '@/lib/backends';
import type { Settings } from '@/lib/settings';

export default function SettingsPage() {
  const toast = useToast();
  const { status, reload } = useStatus(null);
  const presets = backendPresets();
  const [backend, setBackend] = useState<BackendId | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/settings').then(async (r) => {
      const s = (await r.json()) as Settings;
      setBackend(s.backend ?? 'emulator');
    });
  }, []);

  if (!backend) return null;

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error?.message ?? 'Save failed');
      setBackend((body as Settings).backend);
      toast('ok', `Using ${presets[(body as Settings).backend].label}`);
      setTimeout(() => window.location.reload(), 400);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-4xl">
      <PageHeader title="Settings" icon={LuSettings} subtitle="Which local AWS backend the UI talks to. Change the region from the menu in the top bar." />
      <div className="grid grid-cols-1 gap-6">
        <Card>
          <CardHeader title="Backend" subtitle="Credentials are picked up automatically and are never shown here." />
          <div className="flex flex-col gap-5 px-5 py-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {(Object.keys(presets) as BackendId[]).map((id) => {
                const p = presets[id];
                const selected = backend === id;
                const host = (() => { try { return new URL(p.endpoint).host; } catch { return p.endpoint; } })();
                const scheme = p.endpoint.startsWith('https') ? 'HTTPS' : 'HTTP';
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setBackend(id)}
                    className={cn(
                      'flex flex-col items-start gap-1 rounded-xl border px-5 py-4 text-left transition-colors',
                      selected
                        ? 'border-primary-500 bg-primary-25 shadow-s3'
                        : 'border-neutral-100 bg-white hover:border-neutral-200',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-neutral-900">{p.label}</span>
                      {selected ? <Pill tone="blue">Selected</Pill> : null}
                    </span>
                    <span className="font-mono text-xs text-neutral-500">{scheme} · {host}</span>
                    <span className="mt-1 text-sm text-neutral-600">
                      {id === 'emulator'
                        ? 'In-memory AWS APIs. Tasks run as short shell commands.'
                        : 'Real Docker containers for Lambda, ECS and ECR (docker push works).'}
                    </span>
                  </button>
                );
              })}
            </div>
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
                  ['Backend', status.backendLabel ?? status.backend ?? '—'],
                  ['Endpoint', <span key="e" className="font-mono text-[13px]">{status.endpoint}</span>],
                  ['Health check', status.health.ok ? <span key="h" className="inline-flex items-center gap-1 text-gw-green-700"><LuCircleCheck className="h-4 w-4" /> 200 in {status.health.ms} ms</span> : <span key="h" className="inline-flex items-center gap-1 text-gw-red-700"><LuCircleX className="h-4 w-4" /> {status.health.error ?? `HTTP ${status.health.status}`}</span>],
                  ['TLS', status.backend === 'floci' || status.endpoint.startsWith('http:') ? 'Off (HTTP)' : status.tlsVerify ? (status.caLoaded ? "Verified with the emulator's certificate" : 'Certificate not found') : 'Verification off'],
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
