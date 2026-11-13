'use client';

import { useState } from 'react';
import { useSelection } from '@/components/selection';
import { LuPlay, LuPlus, LuTrash2 } from 'react-icons/lu';
import { ListCard, Section } from '@/components/ListCard';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, InlineError } from '@/components/states';
import { DataTable } from '@/components/table';
import { Button, ConfirmDialog, Empty, Field, Input, JsonBlock, KV, Modal, Mono, Pill, Select, StatusPill, Textarea, TimeAgo, formatBytes } from '@/components/ui';
import { useAws } from '@/components/use-aws';
import { useMutation } from '@/components/mutate';

interface Fn { FunctionName: string; FunctionArn: string; Runtime?: string; Handler?: string; MemorySize?: number; Timeout?: number; LastModified?: string; CodeSize?: number; State?: string; Role?: string; PackageType?: string; Architectures?: string[] }
interface InvokeResult { statusCode?: number; functionError?: string; executedVersion?: string; payload: string; logTail: string; captured?: { group: string; stream?: string; skipped?: string }; captureError?: string }

const TEMPLATES: Record<string, string> = {
  'nodejs20.x': "export const handler = async (event) => {\n  console.log('event', JSON.stringify(event));\n  return { ok: true, echo: event };\n};\n",
  'python3.12': "import json\n\ndef handler(event, context):\n    print('event', json.dumps(event))\n    return {'ok': True, 'echo': event}\n",
};

export default function LambdaPage() {
  const list = useAws<Fn[]>('lambda', 'list');
  const [sel, setSel] = useSelection('fn');
  const [creating, setCreating] = useState(false);
  const selected = list.data?.find((f) => f.FunctionName === sel) ?? null;

  return (
    <>
      <PageHeader serviceId="lambda" detail={sel ? { name: sel, onBack: () => setSel(null) } : undefined} actions={<Button variant="primary" onClick={() => setCreating(true)}><LuPlus /> Create function</Button>} />
      <div className="flex flex-col gap-6">
        {!sel ? (
        <ListCard title="Functions" subtitle={list.data ? `${list.data.length} total` : undefined} loading={list.loading} error={list.error} onReload={list.reload} hasData={!!list.data} what="ListFunctions">
          <DataTable
            rows={list.data ?? []}
            rowKey={(f) => f.FunctionName}
            onRowClick={(f) => setSel(f.FunctionName)}
            empty="No functions yet. Create one, or run npm run seed."
            columns={[
              { key: 'name', header: 'Name', cell: (f) => <span className="font-medium text-neutral-900">{f.FunctionName}</span> },
              { key: 'runtime', header: 'Runtime', cell: (f) => <Pill tone="blue">{f.Runtime ?? f.PackageType}</Pill> },
              { key: 'state', header: 'State', cell: (f) => <StatusPill status={f.State ?? 'Active'} /> },
              { key: 'mem', header: 'Memory', align: 'right', cell: (f) => `${f.MemorySize ?? '—'} MB` },
              { key: 'mod', header: 'Modified', cell: (f) => <span className="text-neutral-500"><TimeAgo value={f.LastModified} /></span> },
            ]}
          />
        </ListCard>
        ) : null}
        {selected ? <FunctionDetail key={selected.FunctionName} fn={selected} onDeleted={() => { setSel(null); void list.reload(); }} /> : sel && list.data ? <ListCard title="Function details"><Empty>Not found in this region. It may have been deleted.</Empty></ListCard> : null}
      </div>
      <CreateFunction open={creating} onClose={() => setCreating(false)} onCreated={(n) => { setCreating(false); setSel(n); void list.reload(); }} />
    </>
  );
}

function FunctionDetail({ fn, onDeleted }: { fn: Fn; onDeleted: () => void }) {
  const [payload, setPayload] = useState('{\n  "hello": "world"\n}');
  const [result, setResult] = useState<InvokeResult | null>(null);
  const [confirm, setConfirm] = useState(false);
  const invoke = useMutation();
  const del = useMutation();
  const logs = useAws<{ group: string; events: { timestamp?: number; message?: string; stream?: string; capturedByUi?: boolean }[] }>('lambda', 'logs', { name: fn.FunctionName });

  return (
    <ListCard
      title={fn.FunctionName}
      subtitle={<Mono className="text-neutral-500">{fn.FunctionArn}</Mono>}
      actions={<Button variant="danger" size="sm" onClick={() => setConfirm(true)}><LuTrash2 /> Delete</Button>}
    >
      <div className="flex flex-col gap-6 px-5 py-5">
        <KV items={[['Runtime', fn.Runtime], ['Handler', <Mono key="h">{fn.Handler}</Mono>], ['Timeout', `${fn.Timeout}s`], ['Code size', formatBytes(fn.CodeSize)], ['Architecture', fn.Architectures?.join(', ')], ['Role', <Mono key="r">{fn.Role}</Mono>]]} />
        <Section title="Invoke">
          <Textarea value={payload} onChange={(e) => setPayload(e.target.value)} rows={5} aria-label="Payload" />
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              loading={invoke.busy}
              data-testid="invoke-button"
              onClick={async () => {
                const r = await invoke.run<InvokeResult>('lambda', 'invoke', { name: fn.FunctionName, payload });
                if (r) {
                  setResult(r);
                  void logs.reload();
                }
              }}
            >
              <LuPlay /> Invoke
            </Button>
            {result ? (result.functionError ? <Pill tone="red" dot>{result.functionError}</Pill> : <Pill tone="green" dot>Status {result.statusCode}</Pill>) : null}
            {result?.executedVersion ? <span className="text-xs text-neutral-500">version {result.executedVersion}</span> : null}
          </div>
          <InlineError error={invoke.error} />
          {result ? (
            <div className="grid grid-cols-1 gap-3">
              <div>
                <div className="mb-1 text-xs text-neutral-500">Response payload</div>
                <JsonBlock value={result.payload} maxHeight={220} />
              </div>
              {result.logTail ? (
                <div>
                  <div className="mb-1 text-xs text-neutral-500">Log tail (last 4 KB)</div>
                  <JsonBlock value={result.logTail} maxHeight={220} />
                  {result.captured?.stream ? (
                    <p className="mt-1.5 text-xs text-neutral-500" data-testid="captured-note">
                      <Pill tone="blue">Captured by UI</Pill> Copied to CloudWatch Logs <Mono>{result.captured.group}</Mono>. AWS Emulator didn&apos;t write them because, as on AWS, this function&apos;s role doesn&apos;t allow logs:CreateLogStream / logs:PutLogEvents.
                    </p>
                  ) : result.captureError ? (
                    <p className="mt-1.5 text-xs text-gw-orange-700">Couldn&apos;t copy the log tail to CloudWatch: {result.captureError}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </Section>
        <Section title={`CloudWatch Logs · /aws/lambda/${fn.FunctionName}`} actions={<Button size="sm" variant="ghost" onClick={logs.reload}>Refresh</Button>}>
          {logs.error ? (
            logs.error.name === 'ResourceNotFoundException' ? (
              <p className="rounded-lg border border-neutral-100 bg-neutral-25 px-4 py-3 text-sm text-neutral-600">
                No log group yet. AWS Emulator writes <Mono>/aws/lambda/{fn.FunctionName}</Mono> on invoke when the function&apos;s role allows CloudWatch Logs; otherwise invoking from this page copies the log tail there (marked captured by UI).
              </p>
            ) : (
              <ErrorState error={logs.error} compact what="CloudWatch Logs for Lambda" />
            )
          ) : logs.data?.events.length ? (
            <div className="max-h-64 overflow-auto rounded-lg border border-neutral-100 bg-neutral-25 font-mono text-[12.5px]">
              {logs.data.events.map((e, i) => (
                <div key={i} className="flex gap-3 border-b border-neutral-100 px-3 py-1.5 last:border-0">
                  <span className="shrink-0 text-neutral-500">{e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : ''}</span>
                  {e.capturedByUi ? <Pill tone="blue" className="shrink-0">UI</Pill> : null}
                  <span className="whitespace-pre-wrap break-all text-neutral-800">{e.message}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-neutral-400">{logs.loading ? 'Loading…' : 'No log events.'}</p>
          )}
        </Section>
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Delete ${fn.FunctionName}?`}
        description="This deletes the function and all its versions from the emulator."
        busy={del.busy}
        onConfirm={async () => {
          if (await del.run('lambda', 'delete', { name: fn.FunctionName }, `Deleted ${fn.FunctionName}`)) {
            setConfirm(false);
            onDeleted();
          }
        }}
      />
    </ListCard>
  );
}

function CreateFunction({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (name: string) => void }) {
  const [name, setName] = useState('');
  const [runtime, setRuntime] = useState('nodejs20.x');
  const [code, setCode] = useState(TEMPLATES['nodejs20.x']);
  const m = useMutation();
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Create function"
      description="Zips the code below and calls CreateFunction. Without a role ARN it uses the UI helper role (aws-emulator-ui-role), which lets the function write CloudWatch Logs."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={m.busy} disabled={!name} onClick={async () => (await m.run('lambda', 'create', { name, runtime, code }, `Created ${name}`)) && onCreated(name)}>
            Create
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Function name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-function" autoFocus /></Field>
        <Field label="Runtime">
          <Select value={runtime} onChange={(e) => { setRuntime(e.target.value); setCode(TEMPLATES[e.target.value]); }} options={['nodejs20.x', 'python3.12']} />
        </Field>
      </div>
      <Field label="Code" hint={runtime === 'nodejs20.x' ? 'index.mjs · handler index.handler' : 'lambda_function.py · handler lambda_function.handler'}>
        <Textarea value={code} onChange={(e) => setCode(e.target.value)} rows={10} />
      </Field>
      <InlineError error={m.error} />
    </Modal>
  );
}
